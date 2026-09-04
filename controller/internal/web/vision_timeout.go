package web

import (
	"log"
	"strings"
	"time"
)

// Separate from the lease watchdog: an unrelated device's missing ACK must not
// delay stopping vision motion, and commissioning mode needs the same guard.
func (s *server) visionMotionWatchdog() {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for now := range ticker.C {
		if stopped := s.hub.StopExpiredVisionMotion(now); len(stopped) > 0 {
			log.Printf("vision motion timeout: stop queued for %s", strings.Join(stopped, ", "))
		}
		if s.leases.releaseIdleVision(s.hub.VisionSessionActive) {
			s.hub.Notify()
		}
	}
}
