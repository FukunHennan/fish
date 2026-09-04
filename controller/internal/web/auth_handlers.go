package web

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
)

func writeAuthError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "message": message})
}

func (s *server) authActive() bool {
	// Authentication is temporarily disabled while the project is being
	// commissioned. Set FISH_AUTH_DISABLED=false to re-enable it later.
	value, configured := os.LookupEnv("FISH_AUTH_DISABLED")
	if !configured || strings.TrimSpace(value) == "" {
		return false
	}
	return !strings.EqualFold(strings.TrimSpace(value), "true")
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

func (s *server) requireAdmin(w http.ResponseWriter, r *http.Request) (authUser, bool) {
	user, ok := s.requireUser(w, r)
	if !ok {
		return authUser{}, false
	}
	if !canAdmin(user) {
		writeAuthError(w, http.StatusForbidden, "需要管理员权限")
		return authUser{}, false
	}
	return user, true
}

func (s *server) authMe(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if !s.authActive() {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"authenticated": true,
			"bootstrap":     false,
			"user":          publicUser(s.anonymousAdmin()),
		})
		return
	}
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
			message = "账户只能由管理员创建"
		}
		if strings.TrimSpace(input.Invite) != "" && strings.TrimSpace(os.Getenv("FISH_INVITE_CODE")) != "" {
			message = "邀请码无效"
		}
		writeAuthError(w, status, message)
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
	user, ok := s.requireAdmin(w, r)
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	switch r.Method {
	case http.MethodGet:
		_ = json.NewEncoder(w).Encode(s.auth.listUsers())
	case http.MethodPost:
		var input struct {
			Name, Email, Password, Role string
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			writeAuthError(w, http.StatusBadRequest, "请求格式错误")
			return
		}
		created, err := s.auth.createUser(input.Name, input.Email, input.Password, input.Role)
		if err != nil {
			status, message := http.StatusBadRequest, "账户信息无效，密码至少 8 位"
			if errors.Is(err, os.ErrExist) {
				status, message = http.StatusConflict, "该邮箱已经存在"
			}
			writeAuthError(w, status, message)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"created": true, "user": publicUser(created)})
	case http.MethodPatch:
		var input struct {
			ID       string `json:"id"`
			Name     string `json:"name"`
			Role     string `json:"role"`
			Status   string `json:"status"`
			Password string `json:"password"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil || strings.TrimSpace(input.ID) == "" {
			writeAuthError(w, http.StatusBadRequest, "账户参数无效")
			return
		}
		updated, err := s.auth.updateUser(input.ID, input.Name, input.Role, input.Status, input.Password, user.ID)
		if err != nil {
			status, message := http.StatusBadRequest, "账户参数无效"
			switch {
			case errors.Is(err, os.ErrNotExist):
				status, message = http.StatusNotFound, "账户不存在"
			case errors.Is(err, os.ErrPermission):
				status, message = http.StatusConflict, "不能移除最后一个管理员，也不能修改自己的角色或状态"
			}
			writeAuthError(w, status, message)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"updated": true, "user": publicUser(updated)})
	case http.MethodDelete:
		var input struct {
			ID string `json:"id"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil || strings.TrimSpace(input.ID) == "" {
			writeAuthError(w, http.StatusBadRequest, "账户参数无效")
			return
		}
		if err := s.auth.deleteUser(input.ID, user.ID); err != nil {
			status, message := http.StatusNotFound, "账户不存在"
			if errors.Is(err, os.ErrPermission) {
				status, message = http.StatusConflict, "不能删除自己或最后一个管理员"
			}
			writeAuthError(w, status, message)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"deleted": true})
	default:
		writeAuthError(w, http.StatusMethodNotAllowed, "仅支持 GET / POST / PATCH / DELETE")
	}
}
