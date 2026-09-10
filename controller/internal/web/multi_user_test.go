package web

import (
	"testing"
	"time"
)

func TestUserMayHoldSeveralFish(t *testing.T) {
	l := newLeaseStore(time.Minute)
	u := authUser{ID: "u"}
	l.acquireExclusive("a", u, "manual", false, "tab")
	_, released, ok := l.acquireExclusive("b", u, "manual", false, "tab")
	if !ok || len(released) != 0 {
		t.Fatal("second fish released first")
	}
	for _, id := range []string{"a", "b"} {
		if !l.admit(id, u, "tab", true, func() bool { return true }) {
			t.Fatal("lost lease", id)
		}
		if l.admit(id, authUser{ID: "other"}, "other", false, func() bool { t.Fatal("foreign stop reached queue"); return true }) {
			t.Fatal("foreign stop allowed")
		}
	}
	if _, _, ok := l.acquireExclusive("a", authUser{ID: "other"}, "manual", false, "other"); ok {
		t.Fatal("foreign acquisition allowed")
	}
	l.release("a", u, false, "tab")
	if !l.admit("b", u, "tab", true, func() bool { return true }) {
		t.Fatal("release affected second fish")
	}
}

func TestInactivityStopsMotionButRetainsOwnership(t *testing.T) {
	l := newLeaseStore(time.Minute)
	u := authUser{ID: "u"}
	l.acquireExclusive("a", u, "manual", false, "tab")
	lease := l.leases["a"]
	lease.ExpiresAt = time.Now().Add(-time.Minute)
	l.leases["a"] = lease
	stops := 0
	l.onRelease = func(string) { stops++ }
	l.expire()
	l.expire()
	if stops != 1 || l.snapshot()["a"].OwnerID != "u" {
		t.Fatal("timeout must stop once and preserve owner")
	}
	if _, _, ok := l.acquireExclusive("a", authUser{ID: "other"}, "manual", false, "other"); ok {
		t.Fatal("timeout allowed takeover")
	}
	if !l.release("a", u, false, "tab") {
		t.Fatal("owner cannot release")
	}
}

func TestReservationSurvivesRestart(t *testing.T) {
	path := t.TempDir() + "/owners.json"
	l := newLeaseStore(time.Minute)
	if err := l.loadReservations(path); err != nil {
		t.Fatal(err)
	}
	u := authUser{ID: "owner"}
	if _, _, ok := l.acquireExclusive("a", u, "manual", false, "old-tab"); !ok {
		t.Fatal("claim failed")
	}
	restored := newLeaseStore(time.Minute)
	if err := restored.loadReservations(path); err != nil {
		t.Fatal(err)
	}
	got := restored.snapshot()["a"]
	if got.OwnerID != "owner" || got.ClientID != "" || !got.MotionExpired {
		t.Fatalf("unsafe restoration: %+v", got)
	}
	if _, _, ok := restored.acquireExclusive("a", authUser{ID: "other"}, "manual", false, "tab"); ok {
		t.Fatal("lost reservation")
	}
	if !restored.release("a", u, false) {
		t.Fatal("owner release failed")
	}
	again := newLeaseStore(time.Minute)
	if err := again.loadReservations(path); err != nil {
		t.Fatal(err)
	}
	if len(again.snapshot()) != 0 {
		t.Fatal("released reservation restored")
	}
}

func TestRestoredOwnerMustRecoverBrowserBeforeMotion(t *testing.T) {
	path := t.TempDir() + "/owners.json"
	l := newLeaseStore(time.Minute)
	if err := l.loadReservations(path); err != nil {
		t.Fatal(err)
	}
	u := authUser{ID: "owner"}
	l.acquireExclusive("fish", u, "manual", false, "old")
	restored := newLeaseStore(time.Minute)
	if err := restored.loadReservations(path); err != nil {
		t.Fatal(err)
	}
	if restored.admit("fish", u, "new", true, func() bool { t.Fatal("unclaimed motion queued"); return true }) {
		t.Fatal("unclaimed browser accepted")
	}
	if _, _, ok := restored.acquireExclusive("fish", u, "manual", false, "new"); !ok {
		t.Fatal("owner cannot recover")
	}
	if !restored.admit("fish", u, "new", true, func() bool { return true }) {
		t.Fatal("recovered owner rejected")
	}
	if restored.release("fish", authUser{ID: "other"}, false, "new") {
		t.Fatal("other user released reservation")
	}
	if !restored.release("fish", u, false, "new") {
		t.Fatal("owner release failed")
	}
}
