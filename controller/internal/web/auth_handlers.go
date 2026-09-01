package web

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
)

func (s *server) authActive() bool {
	return !strings.EqualFold(os.Getenv("FISH_AUTH_DISABLED"), "true")
}

func (s *server) anonymousAdmin() authUser {
	return authUser{ID: "local-anonymous", Name: "本地用户", Email: "local@fish", Role: "Admin", Status: "active"}
}

func (s *server) currentUser(r *http.Request) (authUser, bool) {
	if strings.EqualFold(os.Getenv("FISH_TRUST_CF_ACCESS"), "true") {
		if email := strings.TrimSpace(r.Header.Get("Cf-Access-Authenticated-User-Email")); email != "" {
			name := strings.TrimSpace(r.Header.Get("Cf-Access-Authenticated-User-Name"))
			if name == "" {
				name = email
			}
			role := normalizeRole(r.Header.Get("X-Fish-Role"))
			if role == "Viewer" {
				role = "Operator"
			}
			return authUser{ID: "cf:" + email, Name: name, Email: email, Role: role, Status: "active"}, true
		}
	}
	cookie, err := r.Cookie(sessionCookieName)
	if err == nil && cookie.Value != "" {
		if user, ok := s.auth.userBySession(cookie.Value); ok {
			return user, true
		}
	}
	if !s.authActive() {
		return s.anonymousAdmin(), true
	}
	return authUser{}, false
}

func (s *server) requireUser(w http.ResponseWriter, r *http.Request) (authUser, bool) {
	user, ok := s.currentUser(r)
	if ok {
		return user, true
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": false, "message": "请先登录"})
	return authUser{}, false
}

func (s *server) authMe(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	cookie, cookieErr := r.Cookie(sessionCookieName)
	if cookieErr == nil && cookie.Value != "" {
		if user, ok := s.auth.userBySession(cookie.Value); ok {
			_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": true, "bootstrap": false, "user": publicUser(user)})
			return
		}
	}
	if strings.EqualFold(os.Getenv("FISH_TRUST_CF_ACCESS"), "true") {
		if user, ok := s.currentUser(r); ok && strings.HasPrefix(user.ID, "cf:") {
			_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": true, "bootstrap": false, "user": publicUser(user)})
			return
		}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": false, "bootstrap": s.auth.userCount() == 0})
}

func (s *server) authRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST", http.StatusMethodNotAllowed)
		return
	}
	var input struct {
		Name, Email, Password, Invite, Role string
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil {
		http.Error(w, "请求格式错误", http.StatusBadRequest)
		return
	}
	user, created, err := s.auth.register(input.Name, input.Email, input.Password, input.Role, input.Invite)
	if err != nil {
		status := http.StatusBadRequest
		message := "注册信息无效"
		if errors.Is(err, os.ErrPermission) {
			status = http.StatusForbidden
			message = "邀请码无效"
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"created": false, "message": message})
		return
	}
	session, err := s.auth.createSession(user)
	if err == nil && user.Status == "active" {
		setSessionCookie(w, session)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"created": created, "authenticated": user.Status == "active",
		"user": publicUser(user),
	})
}

func (s *server) authLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST", http.StatusMethodNotAllowed)
		return
	}
	var input struct {
		Email, Password string
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil {
		http.Error(w, "请求格式错误", http.StatusBadRequest)
		return
	}
	user, ok := s.auth.authenticate(input.Email, input.Password)
	if !ok {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": false, "message": "邮箱、密码或账号状态不正确"})
		return
	}
	session, err := s.auth.createSession(user)
	if err != nil {
		http.Error(w, "无法创建会话", http.StatusInternalServerError)
		return
	}
	setSessionCookie(w, session)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": true, "user": publicUser(user)})
}

func (s *server) authLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST", http.StatusMethodNotAllowed)
		return
	}
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		s.auth.clearSession(cookie.Value)
	}
	clearSessionCookie(w)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"authenticated": false})
}

func (s *server) authUsers(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if !canAdmin(user) {
		http.Error(w, "需要管理员权限", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.auth.listUsers())
}
