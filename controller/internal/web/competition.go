package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 赛事裁判流程：签到、场地、计时、比分与比赛记录。
// 数据保存在用户配置目录，服务重启后仍可继续。

const (
	matchStateWaiting  = "waiting"
	matchStateSignup   = "signup"
	matchStateReady    = "ready"
	matchStateRunning  = "running"
	matchStatePaused   = "paused"
	matchStateFinished = "finished"
)

type competitionPlayer struct {
	Slot     string `json:"slot"`
	Name     string `json:"name"`
	SignedIn bool   `json:"signedIn"`
	DeviceID string `json:"deviceId,omitempty"`
	SignedAt string `json:"signedAt,omitempty"`
}

type competitionTeam struct {
	Side    string              `json:"side"`
	Name    string              `json:"name"`
	Score   int                 `json:"score"`
	Players []competitionPlayer `json:"players"`
}

type competitionMatch struct {
	ID        string          `json:"id"`
	MatchNo   string          `json:"matchNo"`
	Group     string          `json:"group"`
	Venue     string          `json:"venue"`
	State     string          `json:"state"`
	Blue      competitionTeam `json:"blue"`
	Red       competitionTeam `json:"red"`
	ElapsedMs int64           `json:"elapsedMs"`
	RunningIf bool            `json:"-"`
	StartedAt string          `json:"startedAt,omitempty"`
	UpdatedAt string          `json:"updatedAt"`
	Operator  string          `json:"operator,omitempty"`
}

type competitionRecord struct {
	MatchNo   string `json:"matchNo"`
	Group     string `json:"group"`
	Venue     string `json:"venue"`
	BlueName  string `json:"blueName"`
	RedName   string `json:"redName"`
	BlueScore int    `json:"blueScore"`
	RedScore  int    `json:"redScore"`
	ElapsedMs int64  `json:"elapsedMs"`
	Finished  string `json:"finishedAt"`
}

type competitionStore struct {
	mu      sync.Mutex
	path    string
	Match   *competitionMatch   `json:"match"`
	Records []competitionRecord `json:"records"`
	started time.Time
	running bool
}

func newCompetitionStore(path string) *competitionStore {
	store := &competitionStore{path: path}
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, store)
	}
	return store
}

func competitionPath() string {
	if path := strings.TrimSpace(os.Getenv("FISH_COMPETITION_STATE")); path != "" {
		return path
	}
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "fish-controller", "competition.json")
}

func (c *competitionStore) saveLocked() {
	if c.path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(c.path), 0o700); err != nil {
		return
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return
	}
	temporary := c.path + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return
	}
	_ = os.Rename(temporary, c.path)
}

// elapsedLocked 返回当前累计比赛时长；进行中会叠加本次运行的时长。
func (c *competitionStore) elapsedLocked() int64 {
	if c.Match == nil {
		return 0
	}
	total := c.Match.ElapsedMs
	if c.running && !c.started.IsZero() {
		total += time.Since(c.started).Milliseconds()
	}
	return total
}

func newMatchBlueRed(matchNo, group, venue string) *competitionMatch {
	return &competitionMatch{
		ID:        fmt.Sprintf("match-%d", time.Now().UnixNano()),
		MatchNo:   matchNo,
		Group:     group,
		Venue:     venue,
		State:     matchStateSignup,
		UpdatedAt: time.Now().Format(time.RFC3339),
		Blue: competitionTeam{Side: "blue", Name: "蓝队", Players: []competitionPlayer{
			{Slot: "B1"}, {Slot: "B2"},
		}},
		Red: competitionTeam{Side: "red", Name: "红队", Players: []competitionPlayer{
			{Slot: "R1"}, {Slot: "R2"},
		}},
	}
}

// competitionAPI 汇总裁判端的比赛流程接口。
func (s *server) competitionAPI(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if !canControl(user) {
		http.Error(w, "需要普通用户或管理员权限", http.StatusForbidden)
		return
	}
	store := s.competition
	if store == nil {
		http.Error(w, "赛事流程不可用", http.StatusServiceUnavailable)
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()

	action := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/competition/"), "/")
	// 形如 match/signin 的子操作只取最后一段作为动作名
	if index := strings.LastIndex(action, "/"); index >= 0 {
		action = action[index+1:]
	}
	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodGet {
		switch action {
		case "match":
			writeJSONValue(w, s.matchSnapshotLocked(store))
			return
		case "records":
			records := store.Records
			if records == nil {
				records = []competitionRecord{}
			}
			writeJSONValue(w, map[string]any{"records": records})
			return
		}
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		http.Error(w, "仅支持 GET/POST/PUT", http.StatusMethodNotAllowed)
		return
	}

	var input struct {
		MatchNo  string              `json:"matchNo"`
		Group    string              `json:"group"`
		Venue    string              `json:"venue"`
		Side     string              `json:"side"`
		Slot     string              `json:"slot"`
		Name     string              `json:"name"`
		DeviceID string              `json:"deviceId"`
		SignedIn *bool               `json:"signedIn"`
		Score    *int                `json:"score"`
		Delta    *int                `json:"delta"`
		Action   string              `json:"action"`
		Blue     *competitionTeam    `json:"blue"`
		Red      *competitionTeam    `json:"red"`
		Players  []competitionPlayer `json:"players"`
	}
	if r.Body != nil && r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			http.Error(w, "请求格式错误", http.StatusBadRequest)
			return
		}
	}

	switch action {
	case "match":
		if store.Match == nil {
			store.Match = newMatchBlueRed("", "", "")
		}
		match := store.Match
		if input.MatchNo != "" {
			match.MatchNo = input.MatchNo
		}
		if input.Group != "" {
			match.Group = input.Group
		}
		if input.Venue != "" {
			match.Venue = input.Venue
		}
		// 合并更新：只覆盖传来的字段，保留默认席位，避免裁判改队名时丢掉名单
		if input.Blue != nil {
			mergeTeam(&match.Blue, input.Blue, "blue")
		}
		if input.Red != nil {
			mergeTeam(&match.Red, input.Red, "red")
		}
		if match.State == "" {
			match.State = matchStateSignup
		}
		match.Operator = user.Email
		match.UpdatedAt = time.Now().Format(time.RFC3339)
		store.saveLocked()
		writeJSONValue(w, s.matchSnapshotLocked(store))

	case "signin":
		match := store.Match
		if match == nil {
			http.Error(w, "尚未创建比赛", http.StatusConflict)
			return
		}
		team := match.teamForSide(input.Side)
		if team == nil {
			http.Error(w, "队伍参数无效", http.StatusBadRequest)
			return
		}
		if input.Players != nil {
			team.Players = input.Players
		} else if input.Slot != "" {
			found := false
			for i := range team.Players {
				if strings.EqualFold(team.Players[i].Slot, input.Slot) {
					if input.Name != "" {
						team.Players[i].Name = input.Name
					}
					if input.DeviceID != "" {
						team.Players[i].DeviceID = input.DeviceID
					}
					if input.SignedIn != nil {
						team.Players[i].SignedIn = *input.SignedIn
						if *input.SignedIn {
							team.Players[i].SignedAt = time.Now().Format(time.RFC3339)
						}
					}
					found = true
				}
			}
			if !found {
				http.Error(w, "未找到该席位", http.StatusBadRequest)
				return
			}
		}
		if match.State == matchStateWaiting {
			match.State = matchStateSignup
		}
		// 双方全部签到后进入就绪
		if match.Blue.allSignedIn() && match.Red.allSignedIn() {
			match.State = matchStateReady
		}
		match.Operator = user.Email
		match.UpdatedAt = time.Now().Format(time.RFC3339)
		store.saveLocked()
		writeJSONValue(w, s.matchSnapshotLocked(store))

	case "score":
		match := store.Match
		if match == nil {
			http.Error(w, "尚未创建比赛", http.StatusConflict)
			return
		}
		team := match.teamForSide(input.Side)
		if team == nil {
			http.Error(w, "队伍参数无效", http.StatusBadRequest)
			return
		}
		if input.Score != nil {
			team.Score = *input.Score
		}
		if input.Delta != nil {
			team.Score += *input.Delta
		}
		if team.Score < 0 {
			team.Score = 0
		}
		match.Operator = user.Email
		match.UpdatedAt = time.Now().Format(time.RFC3339)
		store.saveLocked()
		writeJSONValue(w, s.matchSnapshotLocked(store))

	case "clock":
		match := store.Match
		if match == nil {
			http.Error(w, "尚未创建比赛", http.StatusConflict)
			return
		}
		switch strings.ToLower(input.Action) {
		case "start":
			if !store.running {
				store.started = time.Now()
				store.running = true
			}
			match.State = matchStateRunning
			match.StartedAt = time.Now().Format(time.RFC3339)
		case "pause":
			if store.running {
				match.ElapsedMs = store.elapsedLocked()
				store.running = false
			}
			match.State = matchStatePaused
		case "reset":
			store.running = false
			match.ElapsedMs = 0
			match.State = matchStateReady
		default:
			http.Error(w, "计时操作无效", http.StatusBadRequest)
			return
		}
		match.Operator = user.Email
		match.UpdatedAt = time.Now().Format(time.RFC3339)
		store.saveLocked()
		writeJSONValue(w, s.matchSnapshotLocked(store))

	case "finish":
		match := store.Match
		if match == nil {
			http.Error(w, "尚未创建比赛", http.StatusConflict)
			return
		}
		if store.running {
			match.ElapsedMs = store.elapsedLocked()
			store.running = false
		}
		match.State = matchStateFinished
		match.UpdatedAt = time.Now().Format(time.RFC3339)
		store.Records = append([]competitionRecord{{
			MatchNo: match.MatchNo, Group: match.Group, Venue: match.Venue,
			BlueName: match.Blue.Name, RedName: match.Red.Name,
			BlueScore: match.Blue.Score, RedScore: match.Red.Score,
			ElapsedMs: match.ElapsedMs, Finished: time.Now().Format(time.RFC3339),
		}}, store.Records...)
		if len(store.Records) > 200 {
			store.Records = store.Records[:200]
		}
		store.saveLocked()
		writeJSONValue(w, s.matchSnapshotLocked(store))

	default:
		http.NotFound(w, r)
	}
}

// matchSnapshotLocked 返回带实时计时的比赛快照。
func (s *server) matchSnapshotLocked(store *competitionStore) map[string]any {
	if store.Match == nil {
		return map[string]any{"match": nil, "elapsedMs": 0, "running": false}
	}
	elapsed := store.elapsedLocked()
	snapshot := *store.Match
	snapshot.ElapsedMs = elapsed
	return map[string]any{"match": snapshot, "elapsedMs": elapsed, "running": store.running}
}

func (t *competitionTeam) allSignedIn() bool {
	if len(t.Players) == 0 {
		return false
	}
	for _, player := range t.Players {
		if !player.SignedIn {
			return false
		}
	}
	return true
}

func (m *competitionMatch) teamForSide(side string) *competitionTeam {
	switch strings.ToLower(strings.TrimSpace(side)) {
	case "blue", "b":
		return &m.Blue
	case "red", "r":
		return &m.Red
	}
	return nil
}

func writeJSONValue(w http.ResponseWriter, value any) {
	_ = json.NewEncoder(w).Encode(value)
}

// mergeTeam 用传入字段更新队伍，保留未提供的席位列。
func mergeTeam(target *competitionTeam, incoming *competitionTeam, side string) {
	target.Side = side
	if incoming.Name != "" {
		target.Name = incoming.Name
	}
	if len(incoming.Players) > 0 {
		target.Players = incoming.Players
	}
	if incoming.Score != 0 {
		target.Score = incoming.Score
	}
}
