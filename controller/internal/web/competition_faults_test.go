package web

import (
	"encoding/json"
	"fish-controller/internal/hub"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func competitionFaultServer(t *testing.T) *server {
	t.Helper()
	t.Setenv("FISH_AUTH_DISABLED", "true")
	store := newCompetitionStore(filepath.Join(t.TempDir(), "competition.json"))
	store.Match = newMatchBlueRed("第 1 场", "", "")
	store.Match.State = matchStateRunning
	store.Match.Blue.Score = 10
	store.running = true
	store.started = time.Now()
	return &server{competition: store, hub: hub.New()}
}

func competitionFaultRequest(s *server, method, action, body string) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	s.competitionAPI(response, httptest.NewRequest(method, "/api/competition/match/"+action, strings.NewReader(body)))
	return response
}

func obstructCompetitionPath(t *testing.T, store *competitionStore) {
	t.Helper()
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocker, []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	store.path = filepath.Join(blocker, "competition.json")
}

func TestCompetitionScoreSaveFailureRollsBack(t *testing.T) {
	s := competitionFaultServer(t)
	obstructCompetitionPath(t, s.competition)
	response := competitionFaultRequest(s, http.MethodPost, "score", `{"side":"blue","delta":10}`)
	if response.Code != http.StatusInternalServerError || s.competition.Match.Blue.Score != 10 || len(s.competition.Match.Events) != 0 {
		t.Fatalf("failed score was accepted: status=%d match=%+v", response.Code, s.competition.Match)
	}
}

func TestCompetitionFinishSaveFailureKeepsMatchAndRetryIsIdempotent(t *testing.T) {
	s := competitionFaultServer(t)
	id := s.competition.Match.ID
	path := s.competition.path
	obstructCompetitionPath(t, s.competition)
	body := `{"matchId":"` + id + `"}`
	response := competitionFaultRequest(s, http.MethodPost, "finish", body)
	if response.Code != http.StatusInternalServerError || s.competition.Match.ID != id || s.competition.Match.Blue.Score != 10 || len(s.competition.Records) != 0 {
		t.Fatalf("failed finish discarded match: status=%d store=%+v", response.Code, s.competition)
	}
	s.competition.path = path
	response = competitionFaultRequest(s, http.MethodPost, "finish", body)
	if response.Code != http.StatusOK || len(s.competition.Records) != 1 || s.competition.Match.Blue.Score != 0 {
		t.Fatalf("finish retry failed: %d %s", response.Code, response.Body.String())
	}
	nextID := s.competition.Match.ID
	response = competitionFaultRequest(s, http.MethodPost, "finish", body)
	if response.Code != http.StatusOK || s.competition.Match.ID != nextID || len(s.competition.Records) != 1 {
		t.Fatal("duplicate finish archived next match")
	}
	reloaded := newCompetitionStore(path)
	if len(reloaded.Records) != 1 || reloaded.Records[0].BlueScore != 10 || reloaded.Match.ID != nextID {
		t.Fatal("archive and next match were not persisted together")
	}
}

func TestCompetitionRecoveryPausesClockAndInvalidatesRecording(t *testing.T) {
	s := competitionFaultServer(t)
	s.competition.started = time.Now().Add(-5 * time.Second)
	s.competition.Match.RecordingState = "recording"
	s.competition.Match.RecordingID = s.competition.Match.ID
	if err := s.competition.saveLocked(); err != nil {
		t.Fatal(err)
	}
	reloaded := newCompetitionStore(s.competition.path)
	if reloaded.running || reloaded.Match.State != matchStatePaused || reloaded.Match.ElapsedMs < 5000 || reloaded.Match.RecordingState != "interrupted" || reloaded.Match.Blue.Score != 10 {
		t.Fatalf("inconsistent recovery: %+v", reloaded.Match)
	}
}

func TestCompetitionExpiredScoreCannotChangeFinalScore(t *testing.T) {
	s := competitionFaultServer(t)
	s.competition.Match.DurationMs = 1000
	s.competition.started = time.Now().Add(-2 * time.Second)
	response := competitionFaultRequest(s, http.MethodPost, "score", `{"side":"blue","delta":10}`)
	if response.Code != http.StatusConflict || len(s.competition.Records) != 1 || s.competition.Records[0].BlueScore != 10 {
		t.Fatalf("expired score accepted: %d %+v", response.Code, s.competition.Records)
	}
}

func TestCompetitionTimerFinishesWithoutBrowserPolling(t *testing.T) {
	s := competitionFaultServer(t)
	s.competition.Match.DurationMs = 30
	s.competition.mu.Lock()
	s.scheduleCompetitionTickLocked(s.competition)
	s.competition.mu.Unlock()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		s.competition.mu.Lock()
		finished := len(s.competition.Records) == 1 && !s.competition.running
		s.competition.mu.Unlock()
		if finished {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timer did not finish without requests")
}

func TestCompetitionFinishRequiresTargetAndRejectsUnstartedMatch(t *testing.T) {
	s := competitionFaultServer(t)
	if response := competitionFaultRequest(s, http.MethodPost, "finish", `{}`); response.Code != http.StatusBadRequest {
		t.Fatalf("finish accepted missing match ID: %d", response.Code)
	}
	s.competition.running = false
	s.competition.Match.State = matchStateReady
	if response := competitionFaultRequest(s, http.MethodPost, "finish", `{"matchId":"`+s.competition.Match.ID+`"}`); response.Code != http.StatusConflict {
		t.Fatalf("unstarted match was archived: %d", response.Code)
	}
}

func TestDuplicateRecordIDsRemainIndividuallyDeletableAfterReload(t *testing.T) {
	s := competitionFaultServer(t)
	s.competition.Records = []competitionRecord{{ID: "same", BlueScore: 1}, {ID: "same", BlueScore: 2}, {ID: "same#2", BlueScore: 3}}
	if err := s.competition.saveLocked(); err != nil {
		t.Fatal(err)
	}
	s.competition = newCompetitionStore(s.competition.path)
	secondID := s.competition.Records[1].ID
	if secondID == "same" || secondID == "same#2" {
		t.Fatal("legacy duplicate ID collided")
	}
	response := competitionFaultRequest(s, http.MethodDelete, "records", `{"matchId":"`+secondID+`"}`)
	if response.Code != http.StatusOK || len(s.competition.Records) != 2 || s.competition.Records[0].BlueScore != 1 || s.competition.Records[1].BlueScore != 3 {
		t.Fatalf("wrong record deleted: %d %+v", response.Code, s.competition.Records)
	}
}

func TestDeletingLatestRecordClearsFinishedNotice(t *testing.T) {
	s := competitionFaultServer(t)
	record := competitionRecord{ID: "finished"}
	s.competition.Records = []competitionRecord{record}
	s.competition.LastFinished = &record
	s.competition.FinishedNoticeClaims = map[string]map[string]bool{"finished": {"account": true}}
	response := competitionFaultRequest(s, http.MethodDelete, "records", `{"matchId":"finished"}`)
	if response.Code != http.StatusOK || s.competition.LastFinished != nil || len(s.competition.FinishedNoticeClaims) != 0 {
		t.Fatalf("deleted result still has a notice: %d", response.Code)
	}
	if newCompetitionStore(s.competition.path).LastFinished != nil {
		t.Fatal("deleted notice reappeared after restart")
	}
}

func TestDeletingRecordSaveFailureKeepsMetadataAndNotice(t *testing.T) {
	s := competitionFaultServer(t)
	record := competitionRecord{ID: "finished", VideoURL: "/api/vision/recordings/files/keep.mp4"}
	s.competition.Records = []competitionRecord{record}
	s.competition.LastFinished = &record
	obstructCompetitionPath(t, s.competition)
	response := competitionFaultRequest(s, http.MethodDelete, "records", `{"matchId":"finished"}`)
	if response.Code != http.StatusInternalServerError || len(s.competition.Records) != 1 || s.competition.LastFinished == nil {
		t.Fatalf("failed deletion lost metadata: %d", response.Code)
	}
}

func TestPlayerLeaseModesCannotBypassTeamAssignment(t *testing.T) {
	t.Setenv("FISH_AUTH_DISABLED", "false")
	auth := newAuthStore(filepath.Join(t.TempDir(), "users.json"))
	user, err := auth.createUser("blue", "1", "password", "User")
	if err != nil {
		t.Fatal(err)
	}
	session, err := auth.createSession(user)
	if err != nil {
		t.Fatal(err)
	}
	store := &competitionStore{Match: newMatchBlueRed("1", "", "")}
	store.Match.Blue.Players[0].DeviceID = "own"
	store.Match.Red.Players[0].DeviceID = "opponent"
	s := &server{auth: auth, competition: store, leases: newLeaseStore(time.Minute), hub: hub.New()}
	for _, id := range []string{"own", "opponent", "unassigned"} {
		s.hub.Register(hub.Device{ID: id}, assignmentTestConn{})
	}
	request := func(method, path string, body map[string]any) *httptest.ResponseRecorder {
		data, _ := json.Marshal(body)
		r := httptest.NewRequest(method, path, strings.NewReader(string(data)))
		r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: session.Token})
		w := httptest.NewRecorder()
		if path == "/api/leases" {
			s.leasesAPI(w, r)
		} else if path == "/api/command/realtime" {
			s.realtimeCommand(w, r)
		} else {
			s.command(w, r)
		}
		return w
	}
	for _, mode := range []string{"", "manual", "player", "vision", "other"} {
		for _, id := range []string{"opponent", "unassigned"} {
			response := request(http.MethodPost, "/api/leases", map[string]any{"deviceId": id, "mode": mode, "clientId": "tab", "slot": "B1"})
			if response.Code != http.StatusForbidden {
				t.Fatalf("mode %q bypassed assignment for %s: %d", mode, id, response.Code)
			}
		}
	}
	response := request(http.MethodPost, "/api/leases", map[string]any{"deviceId": "own", "mode": "manual", "clientId": "tab"})
	if response.Code != http.StatusOK {
		t.Fatalf("own device rejected: %d %s", response.Code, response.Body.String())
	}
	s.leases.acquireExclusive("opponent", user, "manual", false, "tab")
	for _, path := range []string{"/api/command", "/api/command/realtime"} {
		response = request(http.MethodPost, path, map[string]any{"deviceId": "opponent", "mode": "forward", "clientId": "tab", "frequency": 1, "amplitude": 1, "sequence": 1})
		if response.Code != http.StatusForbidden {
			t.Fatalf("old lease still bypasses assignment at %s: %d", path, response.Code)
		}
	}
}
