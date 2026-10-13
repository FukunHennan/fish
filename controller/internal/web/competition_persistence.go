package web

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

func (c *competitionStore) normalizeRecordIDsLocked() {
	reserved := make(map[string]bool, len(c.Records))
	seen := make(map[string]bool, len(c.Records))
	for _, record := range c.Records {
		reserved[record.ID] = true
	}
	for index := range c.Records {
		record := &c.Records[index]
		if record.ID != "" && !seen[record.ID] {
			seen[record.ID] = true
			continue
		}
		base := record.ID
		if base == "" {
			base = "legacy-match"
		}
		for suffix := 2; ; suffix++ {
			candidate := fmt.Sprintf("%s#%d", base, suffix)
			if !reserved[candidate] {
				record.ID = candidate
				reserved[candidate] = true
				seen[candidate] = true
				break
			}
		}
	}
}

func (c *competitionStore) snapshotLocked() *competitionStore {
	snapshot := &competitionStore{path: c.path, started: c.started, running: c.running, pendingFinish: c.pendingFinish}
	if c.Match != nil {
		match := *c.Match
		match.Blue.Players = append([]competitionPlayer(nil), match.Blue.Players...)
		match.Red.Players = append([]competitionPlayer(nil), match.Red.Players...)
		match.Events = append([]competitionEvent(nil), match.Events...)
		snapshot.Match = &match
	}
	snapshot.Records = append([]competitionRecord(nil), c.Records...)
	for index := range snapshot.Records {
		snapshot.Records[index].Events = append([]competitionEvent(nil), snapshot.Records[index].Events...)
	}
	if c.LastFinished != nil {
		record := *c.LastFinished
		record.Events = append([]competitionEvent(nil), record.Events...)
		snapshot.LastFinished = &record
	}
	if c.FinishedNoticeClaims != nil {
		snapshot.FinishedNoticeClaims = make(map[string]map[string]bool, len(c.FinishedNoticeClaims))
		for matchID, claims := range c.FinishedNoticeClaims {
			copied := make(map[string]bool, len(claims))
			for accountID, claimed := range claims {
				copied[accountID] = claimed
			}
			snapshot.FinishedNoticeClaims[matchID] = copied
		}
	}
	return snapshot
}

func (c *competitionStore) restoreLocked(snapshot *competitionStore) {
	c.Match = snapshot.Match
	c.Records = snapshot.Records
	c.LastFinished = snapshot.LastFinished
	c.FinishedNoticeClaims = snapshot.FinishedNoticeClaims
	c.started = snapshot.started
	c.running = snapshot.running
	c.pendingFinish = snapshot.pendingFinish
}

func (s *server) saveCompetitionLocked(w http.ResponseWriter, store, previous *competitionStore) bool {
	if err := store.saveLocked(); err != nil {
		store.restoreLocked(previous)
		s.event("competition_save_failed", "error", err.Error())
		http.Error(w, "比赛数据保存失败，操作未生效，请重试", http.StatusInternalServerError)
		return false
	}
	return true
}

func (s *server) playerDevicePermission(user authUser, deviceID string) bool {
	if !s.authActive() || user.Role != "User" {
		return true
	}
	side := competitionSideForUser(user)
	if side == "" || s.competition == nil {
		return false
	}
	s.competition.mu.Lock()
	defer s.competition.mu.Unlock()
	if s.competition.Match == nil {
		return false
	}
	assignedSide, _, assigned := s.competition.Match.assignmentOwner(deviceID)
	return assigned && assignedSide == side
}

func (s *server) scheduleCompetitionTickLocked(store *competitionStore) {
	if store.clockTimer != nil {
		store.clockTimer.Stop()
		store.clockTimer = nil
	}
	if store.Match == nil || !store.running {
		return
	}
	matchID := store.Match.ID
	delay := time.Second
	remaining := time.Duration(store.Match.DurationMs-store.elapsedLocked()) * time.Millisecond
	if remaining < delay {
		delay = remaining
	}
	if delay < time.Millisecond {
		delay = time.Millisecond
	}
	store.clockTimer = time.AfterFunc(delay, func() {
		store.mu.Lock()
		defer store.mu.Unlock()
		if store.Match == nil || store.Match.ID != matchID || !store.running {
			return
		}
		if store.Match.DurationMs > 0 && store.elapsedLocked() >= store.Match.DurationMs {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := s.finishCompetitionLocked(ctx, store, "system"); err != nil {
				s.event("competition_finish_failed", "match_id", matchID, "error", err.Error())
			}
			return
		}
		if err := store.saveLocked(); err != nil {
			s.event("competition_checkpoint_failed", "match_id", matchID, "error", err.Error())
		}
		s.scheduleCompetitionTickLocked(store)
	})
}
