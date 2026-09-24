package web

import (
	"encoding/json"
	"fmt"
	"math"
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
	Slot          string `json:"slot"`
	Name          string `json:"name"`
	Email         string `json:"email,omitempty"`
	SignedIn      bool   `json:"signedIn"`
	DeviceID      string `json:"deviceId,omitempty"`
	SignedAt      string `json:"signedAt,omitempty"`
	Ready         bool   `json:"ready"`
	ReadyAt       string `json:"readyAt,omitempty"`
	ReadyDeviceID string `json:"readyDeviceId,omitempty"`
	VisionTrackID *int   `json:"visionTrackId,omitempty"`
}

type competitionTeam struct {
	Side    string              `json:"side"`
	Name    string              `json:"name"`
	Score   int                 `json:"score"`
	Players []competitionPlayer `json:"players"`
}

type competitionMatch struct {
	ID                 string          `json:"id"`
	MatchNo            string          `json:"matchNo"`
	Group              string          `json:"group"`
	Venue              string          `json:"venue"`
	State              string          `json:"state"`
	Blue               competitionTeam `json:"blue"`
	Red                competitionTeam `json:"red"`
	ElapsedMs          int64           `json:"elapsedMs"`
	RunningIf          bool            `json:"-"`
	StartedAt          string          `json:"startedAt,omitempty"`
	UpdatedAt          string          `json:"updatedAt"`
	Operator           string          `json:"operator,omitempty"`
	RecordingID        string          `json:"recordingId,omitempty"`
	RecordingState     string          `json:"recordingState,omitempty"`
	RecordingStartedAt string          `json:"recordingStartedAt,omitempty"`
	RecordingError     string          `json:"recordingError,omitempty"`
	FieldWidthCm       float64         `json:"fieldWidthCm,omitempty"`
	FieldHeightCm      float64         `json:"fieldHeightCm,omitempty"`
	FieldLocked        bool            `json:"fieldLocked"`
	DurationMs         int64           `json:"durationMs"`
}

type competitionRecord struct {
	ID                 string  `json:"id"`
	MatchNo            string  `json:"matchNo"`
	Group              string  `json:"group"`
	Venue              string  `json:"venue"`
	BlueName           string  `json:"blueName"`
	RedName            string  `json:"redName"`
	BlueScore          int     `json:"blueScore"`
	RedScore           int     `json:"redScore"`
	ElapsedMs          int64   `json:"elapsedMs"`
	Finished           string  `json:"finishedAt"`
	StartedAt          string  `json:"startedAt,omitempty"`
	VideoURL           string  `json:"videoUrl,omitempty"`
	VideoStatus        string  `json:"videoStatus"`
	VideoDurationMs    int64   `json:"videoDurationMs,omitempty"`
	VideoFrameCount    int64   `json:"videoFrameCount,omitempty"`
	VideoDroppedFrames int64   `json:"videoDroppedFrames,omitempty"`
	VideoAverageFPS    float64 `json:"videoAverageFps,omitempty"`
	VideoWidth         int     `json:"videoWidth,omitempty"`
	VideoHeight        int     `json:"videoHeight,omitempty"`
	VideoError         string  `json:"videoError,omitempty"`
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
		State:      matchStateSignup,
		DurationMs: 180000,
		UpdatedAt: time.Now().Format(time.RFC3339),
		Blue: competitionTeam{Side: "blue", Name: "蓝队", Players: []competitionPlayer{
			{Slot: "B1"}, {Slot: "B2"},
		}},
		Red: competitionTeam{Side: "red", Name: "红队", Players: []competitionPlayer{
			{Slot: "R1"}, {Slot: "R2"},
		}},
	}
}

func newDevelopmentMatch() *competitionMatch {
	now := time.Now().Format(time.RFC3339)
	return &competitionMatch{
		ID:        fmt.Sprintf("dev-match-%d", time.Now().UnixNano()),
		MatchNo:   "第 08 场",
		Group:     "学生组",
		Venue:     "A 赛场",
		State:      matchStateReady,
		DurationMs: 180000,
		UpdatedAt: now,
		Operator:  "local@fish",
		Blue: competitionTeam{Side: "blue", Name: "海洋先锋队", Players: []competitionPlayer{
			{Slot: "B1", Name: "陈同学", Email: "stu-24018@fish.local", SignedIn: true, SignedAt: now},
			{Slot: "B2", Name: "李同学", Email: "stu-24027@fish.local", SignedIn: true, SignedAt: now},
		}},
		Red: competitionTeam{Side: "red", Name: "深海动力队", Players: []competitionPlayer{
			{Slot: "R1", Name: "王同学", Email: "stu-24031@fish.local", SignedIn: true, SignedAt: now},
			{Slot: "R2", Name: "赵同学", Email: "stu-24039@fish.local", SignedIn: true, SignedAt: now},
		}},
	}
}

// ensureDevelopmentMatch creates the local commissioning roster once. The
// resulting file is then the source of truth, so later device assignments and
// sign-in changes survive controller restarts.
func (c *competitionStore) ensureDevelopmentMatch() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.Match != nil {
		return
	}
	c.Match = newDevelopmentMatch()
	c.saveLocked()
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
			if s.clearUnavailableReadinessLocked(store) {
				store.saveLocked()
			}
			writeJSONValue(w, s.matchSnapshotLocked(store))
			return
		case "records":
			records := store.Records
			if records == nil {
				records = []competitionRecord{}
			}
			writeJSONValue(w, map[string]any{"records": records})
			return
		case "devices":
			// 可分配机器鱼列表：在线设备 + 当前归属席位
			writeJSONValue(w, s.competitionDevicesLocked(store))
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
		MatchNo       string              `json:"matchNo"`
		Group         string              `json:"group"`
		Venue         string              `json:"venue"`
		Side          string              `json:"side"`
		Slot          string              `json:"slot"`
		Name          string              `json:"name"`
		Email         string              `json:"email"`
		DeviceID      string              `json:"deviceId"`
		TargetTrackID *int                `json:"targetTrackId"`
		SignedIn      *bool               `json:"signedIn"`
		Ready         *bool               `json:"ready"`
		Score         *int                `json:"score"`
		Delta         *int                `json:"delta"`
		Action        string              `json:"action"`
		Blue          *competitionTeam    `json:"blue"`
		Red           *competitionTeam    `json:"red"`
		Players       []competitionPlayer `json:"players"`
		FieldWidthCm  *float64            `json:"fieldWidthCm"`
		FieldHeightCm *float64            `json:"fieldHeightCm"`
		FieldLocked   *bool               `json:"fieldLocked"`
		DurationMs    *int64              `json:"durationMs"`
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
		if match.DurationMs <= 0 {
			match.DurationMs = 180000
		}
		if input.MatchNo != "" {
			match.MatchNo = input.MatchNo
		}
		if input.Group != "" {
			match.Group = input.Group
		}
		if input.Venue != "" {
			match.Venue = input.Venue
		}
		if input.DurationMs != nil {
			if *input.DurationMs < 10000 || *input.DurationMs > 3600000 {
				http.Error(w, "比赛时长须为 10 秒至 60 分钟", http.StatusBadRequest)
				return
			}
			if match.State == matchStateRunning || match.State == matchStatePaused {
				http.Error(w, "比赛进行或暂停期间不能修改时长", http.StatusConflict)
				return
			}
			match.DurationMs = *input.DurationMs
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

	case "field":
		match := store.Match
		if match == nil {
			http.Error(w, "尚未创建比赛", http.StatusConflict)
			return
		}
		if input.FieldWidthCm == nil || input.FieldHeightCm == nil ||
			math.IsNaN(*input.FieldWidthCm) || math.IsInf(*input.FieldWidthCm, 0) ||
			math.IsNaN(*input.FieldHeightCm) || math.IsInf(*input.FieldHeightCm, 0) ||
			*input.FieldWidthCm < 1 || *input.FieldWidthCm > 100000 ||
			*input.FieldHeightCm < 1 || *input.FieldHeightCm > 100000 {
			http.Error(w, "场地宽度和高度必须是 1–100000 cm 的有效数值", http.StatusBadRequest)
			return
		}
		match.FieldWidthCm = math.Round(*input.FieldWidthCm*10) / 10
		match.FieldHeightCm = math.Round(*input.FieldHeightCm*10) / 10
		match.Operator = user.Email
		match.UpdatedAt = time.Now().Format(time.RFC3339)
		store.saveLocked()
		writeJSONValue(w, s.matchSnapshotLocked(store))

	case "field-lock":
		if !canAdmin(user) {
			http.Error(w, "锁定场地需要管理员权限", http.StatusForbidden)
			return
		}
		match := store.Match
		if match == nil || input.FieldLocked == nil {
			http.Error(w, "场地锁定参数无效", http.StatusBadRequest)
			return
		}
		match.FieldLocked = *input.FieldLocked
		match.Operator = user.Email
		match.UpdatedAt = time.Now().Format(time.RFC3339)
		store.saveLocked()
		// Entering or leaving the player-control phase invalidates all browser
		// leases. Players reacquire their assigned fish after the new state is
		// visible; administrator and vision takeovers remain available.
		s.leases.releaseBrowserLeases()
		s.hub.Notify()
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
					if input.Email != "" {
						team.Players[i].Email = input.Email
					}
					if input.DeviceID != "" && !strings.EqualFold(team.Players[i].DeviceID, input.DeviceID) {
						team.Players[i].clearReady()
						team.Players[i].DeviceID = input.DeviceID
					}
					if input.SignedIn != nil {
						team.Players[i].SignedIn = *input.SignedIn
						if *input.SignedIn {
							team.Players[i].SignedAt = time.Now().Format(time.RFC3339)
						} else {
							team.Players[i].clearReady()
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

	case "assign":
		match := store.Match
		if match == nil {
			http.Error(w, "尚未创建比赛", http.StatusConflict)
			return
		}
		team := match.teamForSide(input.Side)
		if team == nil || strings.TrimSpace(input.Slot) == "" {
			http.Error(w, "队伍或席位参数无效", http.StatusBadRequest)
			return
		}
		deviceID := strings.TrimSpace(input.DeviceID)
		deviceID = s.connectedDeviceID(deviceID)
		if deviceID == "" {
			http.Error(w, "缺少机器鱼参数", http.StatusBadRequest)
			return
		}
		if !s.deviceOnline(deviceID) {
			http.Error(w, "该机器鱼当前不在线", http.StatusConflict)
			return
		}
		// 换绑是幂等操作：新席位接管机器鱼时，旧席位自动释放。
		// 这样裁判不需要先手动解除，再重新分配，设备归属始终只有一个来源。
		if side, slot, taken := match.assignmentOwner(deviceID); taken {
			sameSlot := strings.EqualFold(side, team.Side) && strings.EqualFold(slot, input.Slot)
			if !sameSlot {
				match.clearDeviceAssignment(deviceID)
			}
		}
		assigned := false
		for i := range team.Players {
			if strings.EqualFold(team.Players[i].Slot, input.Slot) {
				if !strings.EqualFold(team.Players[i].DeviceID, deviceID) {
					team.Players[i].clearReady()
				}
				team.Players[i].DeviceID = deviceID
				assigned = true
			}
		}
		if !assigned {
			http.Error(w, "未找到该席位", http.StatusBadRequest)
			return
		}
		match.Operator = user.Email
		match.UpdatedAt = time.Now().Format(time.RFC3339)
		store.saveLocked()
		writeJSONValue(w, s.matchSnapshotLocked(store))

	case "unassign":
		match := store.Match
		if match == nil {
			http.Error(w, "尚未创建比赛", http.StatusConflict)
			return
		}
		team := match.teamForSide(input.Side)
		if team == nil || strings.TrimSpace(input.Slot) == "" {
			http.Error(w, "队伍或席位参数无效", http.StatusBadRequest)
			return
		}
		for i := range team.Players {
			if strings.EqualFold(team.Players[i].Slot, input.Slot) {
				team.Players[i].DeviceID = ""
				team.Players[i].clearReady()
			}
		}
		match.Operator = user.Email
		match.UpdatedAt = time.Now().Format(time.RFC3339)
		store.saveLocked()
		writeJSONValue(w, s.matchSnapshotLocked(store))

	case "ready":
		match := store.Match
		if match == nil {
			http.Error(w, "尚未创建比赛", http.StatusConflict)
			return
		}
		team := match.teamForSide(input.Side)
		if team == nil || strings.TrimSpace(input.Slot) == "" || input.Ready == nil {
			http.Error(w, "队伍、席位或准备状态参数无效", http.StatusBadRequest)
			return
		}
		found := false
		for i := range team.Players {
			player := &team.Players[i]
			if !strings.EqualFold(player.Slot, input.Slot) {
				continue
			}
			found = true
			if !*input.Ready {
				player.clearReady()
				break
			}
			deviceID := strings.TrimSpace(player.DeviceID)
			if deviceID == "" {
				http.Error(w, "该席位尚未分配机器鱼", http.StatusConflict)
				return
			}
			if input.DeviceID != "" && !strings.EqualFold(deviceID, input.DeviceID) {
				http.Error(w, "机器鱼分配已变化，请刷新后重试", http.StatusConflict)
				return
			}
			if !s.deviceOnline(deviceID) {
				http.Error(w, "该席位的机器鱼当前不在线", http.StatusConflict)
				return
			}
			player.Ready = true
			player.ReadyAt = time.Now().Format(time.RFC3339)
			player.ReadyDeviceID = deviceID
			break
		}
		if !found {
			http.Error(w, "未找到该席位", http.StatusBadRequest)
			return
		}
		match.UpdatedAt = time.Now().Format(time.RFC3339)
		store.saveLocked()
		writeJSONValue(w, s.matchSnapshotLocked(store))

	case "vision-bind", "vision-unbind":
		match := store.Match
		if match == nil {
			http.Error(w, "尚未创建比赛", http.StatusConflict)
			return
		}
		team := match.teamForSide(input.Side)
		if team == nil || strings.TrimSpace(input.Slot) == "" {
			http.Error(w, "队伍或席位参数无效", http.StatusBadRequest)
			return
		}
		var selected *competitionPlayer
		for i := range team.Players {
			if strings.EqualFold(team.Players[i].Slot, input.Slot) {
				selected = &team.Players[i]
				break
			}
		}
		if selected == nil {
			http.Error(w, "未找到该席位", http.StatusBadRequest)
			return
		}
		if action == "vision-unbind" {
			selected.VisionTrackID = nil
		} else {
			if input.TargetTrackID == nil || *input.TargetTrackID < 0 {
				http.Error(w, "YOLO 目标编号无效", http.StatusBadRequest)
				return
			}
			trackID := *input.TargetTrackID
			previousTrackID := selected.VisionTrackID
			// 一个 YOLO Track 只能代表一个比赛席位。若目标已经被占用，
			// 与当前席位交换原绑定；当前席位原本未绑定时则释放旧席位。
			for _, candidateTeam := range []*competitionTeam{&match.Blue, &match.Red} {
				for i := range candidateTeam.Players {
					candidate := &candidateTeam.Players[i]
					if candidate == selected || candidate.VisionTrackID == nil || *candidate.VisionTrackID != trackID {
						continue
					}
					if candidateTeam != team {
						http.Error(w, "该 YOLO 目标已绑定对方席位 "+candidate.Slot, http.StatusConflict)
						return
					}
					candidate.VisionTrackID = copyTrackID(previousTrackID)
				}
			}
			selected.VisionTrackID = copyTrackID(&trackID)
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
				if match.RecordingState != "recording" {
					recording, err := s.startCompetitionRecording(r.Context(), match)
					if err != nil {
						match.RecordingState = "error"
						match.RecordingError = err.Error()
						match.UpdatedAt = time.Now().Format(time.RFC3339)
						store.saveLocked()
						http.Error(w, "比赛未开始：录像启动失败："+err.Error(), http.StatusBadGateway)
						return
					}
					match.RecordingID = recording.RecordingID
					match.RecordingState = "recording"
					match.RecordingStartedAt = recording.StartedAt
					match.RecordingError = ""
				}
				store.started = time.Now()
				store.running = true
			}
			match.State = matchStateRunning
			if match.StartedAt == "" {
				match.StartedAt = time.Now().Format(time.RFC3339)
			}
		case "pause":
			if store.running {
				match.ElapsedMs = store.elapsedLocked()
				store.running = false
			}
			match.State = matchStatePaused
		case "reset":
			if match.RecordingState == "recording" && match.RecordingID != "" {
				if _, err := s.stopCompetitionRecording(r.Context(), match.RecordingID, true); err != nil {
					match.RecordingState = "error"
					match.RecordingError = err.Error()
					store.saveLocked()
					http.Error(w, "录像停止失败："+err.Error(), http.StatusBadGateway)
					return
				}
			}
			store.running = false
			match.ElapsedMs = 0
			match.State = matchStateReady
			match.StartedAt = ""
			match.RecordingID = ""
			match.RecordingState = ""
			match.RecordingStartedAt = ""
			match.RecordingError = ""
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
		if match.State == matchStateFinished {
			writeJSONValue(w, s.matchSnapshotLocked(store))
			return
		}
		if store.running {
			match.ElapsedMs = store.elapsedLocked()
			store.running = false
		}
		var recording competitionRecordingResult
		var recordingErr error
		if match.RecordingState == "recording" && match.RecordingID != "" {
			recording, recordingErr = s.stopCompetitionRecording(r.Context(), match.RecordingID, false)
			if recordingErr != nil {
				match.RecordingState = "error"
				match.RecordingError = recordingErr.Error()
			} else {
				match.RecordingState = "saved"
				match.RecordingError = ""
			}
		}
		match.State = matchStateFinished
		match.UpdatedAt = time.Now().Format(time.RFC3339)
		store.Records = append([]competitionRecord{{
			ID:      match.ID,
			MatchNo: match.MatchNo, Group: match.Group, Venue: match.Venue,
			BlueName: match.Blue.Name, RedName: match.Red.Name,
			BlueScore: match.Blue.Score, RedScore: match.Red.Score,
			ElapsedMs: match.ElapsedMs, Finished: time.Now().Format(time.RFC3339),
			StartedAt:          match.StartedAt,
			VideoURL:           recordingPlaybackURL(recording.FileName),
			VideoStatus:        match.RecordingState,
			VideoDurationMs:    recording.DurationMs,
			VideoFrameCount:    recording.FrameCount,
			VideoDroppedFrames: recording.DroppedFrames,
			VideoAverageFPS:    recording.AverageFPS,
			VideoWidth:         recording.Width,
			VideoHeight:        recording.Height,
			VideoError:         match.RecordingError,
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
	if store.Match.DurationMs <= 0 {
		store.Match.DurationMs = 180000
	}
	elapsed := store.elapsedLocked()
	snapshot := *store.Match
	snapshot.ElapsedMs = elapsed
	remaining := snapshot.DurationMs - elapsed
	if remaining < 0 {
		remaining = 0
	}
	return map[string]any{"match": snapshot, "elapsedMs": elapsed, "remainingMs": remaining, "running": store.running}
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

func (p *competitionPlayer) clearReady() {
	p.Ready = false
	p.ReadyAt = ""
	p.ReadyDeviceID = ""
}

func copyTrackID(trackID *int) *int {
	if trackID == nil {
		return nil
	}
	value := *trackID
	return &value
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

// assignmentOwner 返回该机器鱼当前归属的席位。
func (m *competitionMatch) assignmentOwner(deviceID string) (string, string, bool) {
	for _, team := range []competitionTeam{m.Blue, m.Red} {
		for _, player := range team.Players {
			if player.DeviceID != "" && strings.EqualFold(player.DeviceID, deviceID) {
				return team.Side, player.Slot, true
			}
		}
	}
	return "", "", false
}

func (s *server) playerControlAllowed(deviceID, slot string) bool {
	store := s.competition
	if store == nil {
		return false
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.Match == nil || !store.Match.FieldLocked {
		return false
	}
	_, assignedSlot, assigned := store.Match.assignmentOwner(deviceID)
	return assigned && strings.EqualFold(strings.TrimSpace(assignedSlot), strings.TrimSpace(slot))
}

// clearDeviceAssignment removes a machine fish from every match seat.
func (m *competitionMatch) clearDeviceAssignment(deviceID string) {
	for _, team := range []*competitionTeam{&m.Blue, &m.Red} {
		for i := range team.Players {
			if strings.EqualFold(team.Players[i].DeviceID, deviceID) {
				team.Players[i].DeviceID = ""
				team.Players[i].clearReady()
			}
		}
	}
}

// clearUnavailableReadinessLocked keeps the ready flag tied to the exact
// assigned, online machine fish. A disconnect or reassignment invalidates the
// player's previous confirmation instead of leaving a stale ready state.
func (s *server) clearUnavailableReadinessLocked(store *competitionStore) bool {
	if store.Match == nil {
		return false
	}
	changed := false
	for _, team := range []*competitionTeam{&store.Match.Blue, &store.Match.Red} {
		for i := range team.Players {
			player := &team.Players[i]
			if !player.Ready {
				continue
			}
			deviceID := strings.TrimSpace(player.DeviceID)
			if deviceID == "" || !strings.EqualFold(deviceID, player.ReadyDeviceID) || !s.deviceOnline(deviceID) {
				player.clearReady()
				changed = true
			}
		}
	}
	if changed {
		store.Match.UpdatedAt = time.Now().Format(time.RFC3339)
	}
	return changed
}

// deviceOnline 判断机器鱼是否在线。
func (s *server) deviceOnline(deviceID string) bool {
	for _, device := range s.hub.List() {
		if strings.EqualFold(strings.TrimSpace(device.ID), strings.TrimSpace(deviceID)) && device.Online {
			return true
		}
	}
	return false
}

// competitionDevicesLocked 汇总可分配机器鱼及其归属。
func (s *server) competitionDevicesLocked(store *competitionStore) map[string]any {
	devices := []map[string]any{}
	seen := map[string]bool{}
	for _, device := range s.hub.List() {
		seen[strings.ToLower(device.ID)] = true
		item := map[string]any{
			"deviceId":             device.ID,
			"name":                 device.Name,
			"online":               device.Online,
			"ip":                   device.IP,
			"firmwareVersion":      device.FirmwareVersion,
			"rssi":                 device.RSSI,
			"batteryVoltage":       device.BatteryVoltage,
			"batteryPercent":       device.BatteryPercent,
			"heartbeatRttMs":       device.HeartbeatRTTMs,
			"lastSeen":             device.LastSeen,
			"mode":                 device.Mode,
			"frequency":            device.Frequency,
			"amplitude":            device.Amplitude,
			"bias":                 device.Bias,
			"lastControlMs":        device.LastControlMs,
			"lastCommandRequestId": device.LastCommandRequestID,
			"lastCommandAcked":     device.LastCommandAcked,
			"lastCommandSuccess":   device.LastCommandSuccess,
			"lastCommandCode":      device.LastCommandCode,
			"lastCommandMessage":   device.LastCommandMessage,
			"commandAckAtMs":       device.CommandAckAtMs,
			"stopReason":           device.StopReason,
			"controlSource":        device.ControlSource,
			"visionActive":         device.VisionActive,
		}
		if store.Match != nil {
			if side, slot, ok := store.Match.assignmentOwner(device.ID); ok {
				item["side"] = side
				item["slot"] = slot
				item["assignedTo"] = side + "/" + slot
			}
		}
		devices = append(devices, item)
	}
	// A controller restart can happen before a fish reconnects. Keep persisted
	// assignments visible as offline placeholders instead of reporting that the
	// referee's assignment disappeared.
	if store.Match != nil {
		for _, team := range []competitionTeam{store.Match.Blue, store.Match.Red} {
			for _, player := range team.Players {
				deviceID := strings.TrimSpace(player.DeviceID)
				if deviceID == "" || seen[strings.ToLower(deviceID)] {
					continue
				}
				seen[strings.ToLower(deviceID)] = true
				devices = append(devices, map[string]any{
					"deviceId":   deviceID,
					"name":       deviceID,
					"online":     false,
					"side":       team.Side,
					"slot":       player.Slot,
					"assignedTo": team.Side + "/" + player.Slot,
				})
			}
		}
	}
	return map[string]any{"devices": devices}
}
