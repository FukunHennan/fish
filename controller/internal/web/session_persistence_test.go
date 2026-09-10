package web

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoginSurvivesRestartAndLogoutPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users.json")
	a := newAuthStore(path)
	u := authUser{ID: "u", Email: "u@example.com", Status: "active", Role: "User"}
	a.users[u.Email] = u
	if err := a.saveLocked(); err != nil {
		t.Fatal(err)
	}
	session, err := a.createSession(u)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path + ".sessions.json")
	if strings.Contains(string(data), session.Token) {
		t.Fatal("raw bearer token persisted")
	}
	b := newAuthStore(path)
	if _, ok := b.userBySession(session.Token); !ok {
		t.Fatal("session lost on restart")
	}
	if err := b.clearSession(session.Token); err != nil {
		t.Fatal(err)
	}
	c := newAuthStore(path)
	if _, ok := c.userBySession(session.Token); ok {
		t.Fatal("logged out session restored")
	}
}
func TestExpiredAndRevokedSessionsStayInvalid(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users.json")
	a := newAuthStore(path)
	u := authUser{ID: "u", Email: "u", Status: "active"}
	a.users[u.Email] = u
	a.saveLocked()
	session, _ := a.createSession(u)
	key := sessionKey(session.Token)
	expired := a.sessions[key]
	expired.ExpiresAt = time.Now().Add(-time.Hour)
	a.sessions[key] = expired
	a.saveSessionsLocked()
	if _, ok := newAuthStore(path).userBySession(session.Token); ok {
		t.Fatal("expired session restored")
	}
	next, _ := a.createSession(u)
	a.clearSessionsLocked(u.ID)
	a.saveLocked()
	if _, ok := newAuthStore(path).userBySession(next.Token); ok {
		t.Fatal("revoked session restored")
	}
}
