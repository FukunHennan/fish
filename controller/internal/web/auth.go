package web

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const sessionCookieName = "fish_session"

type authUser struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Email        string    `json:"email"`
	Role         string    `json:"role"`
	Status       string    `json:"status"`
	PasswordSalt string    `json:"passwordSalt,omitempty"`
	PasswordHash string    `json:"passwordHash,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
	LastLoginAt  time.Time `json:"lastLoginAt,omitempty"`
}

type authSession struct {
	Token     string
	UserID    string
	ExpiresAt time.Time
}

type authStore struct {
	mu       sync.Mutex
	path     string
	users    map[string]authUser
	sessions map[string]authSession
}

func authStorePath() string {
	if path := strings.TrimSpace(os.Getenv("FISH_AUTH_USERS")); path != "" {
		return path
	}
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "fish-controller", "users.json")
}

func newAuthStore(path string) *authStore {
	store := &authStore{path: path, users: map[string]authUser{}, sessions: map[string]authSession{}}
	_ = store.load()
	return store
}

func (a *authStore) load() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	data, err := os.ReadFile(a.path)
	if err != nil {
		return err
	}
	var users map[string]authUser
	if err := json.Unmarshal(data, &users); err != nil {
		return err
	}
	changed := false
	for email, user := range users {
		canonicalRole := normalizeRole(user.Role)
		if user.Role != canonicalRole {
			user.Role = canonicalRole
			users[email] = user
			changed = true
		}
	}
	a.users = users
	if changed {
		// Migrate legacy Operator/Viewer records to the two-role model.
		_ = a.saveLocked()
	}
	return nil
}

func (a *authStore) saveLocked() error {
	data, err := json.MarshalIndent(a.users, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(a.path), 0o700); err != nil {
		return err
	}
	tmp := a.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, a.path)
}

func randomHex(bytes int) (string, error) {
	value := make([]byte, bytes)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func passwordDigest(salt, password string) string {
	sum := sha256.Sum256([]byte(salt + "\x00" + password))
	return hex.EncodeToString(sum[:])
}

func publicUser(user authUser) map[string]any {
	return map[string]any{
		"id": user.ID, "name": user.Name, "email": user.Email,
		"role": user.Role, "roleLabel": roleLabel(user.Role), "status": user.Status,
		"createdAt": user.CreatedAt, "lastLoginAt": user.LastLoginAt,
	}
}

func roleLabel(role string) string {
	if normalizeRole(role) == "Admin" {
		return "管理员"
	}
	return "普通用户"
}

func normalizeRole(role string) string {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "admin":
		return "Admin"
	case "user", "普通用户", "normal", "operator", "viewer":
		return "User"
	default:
		return "User"
	}
}

func (a *authStore) userCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.users)
}

func (a *authStore) register(name, email, password, role, invite string) (authUser, bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.users) != 0 {
		return authUser{}, false, os.ErrPermission
	}
	email = strings.ToLower(strings.TrimSpace(email))
	name = strings.TrimSpace(name)
	if name == "" {
		name = email
	}
	configuredInvite := strings.TrimSpace(os.Getenv("FISH_INVITE_CODE"))
	if configuredInvite != "" && subtle.ConstantTimeCompare([]byte(strings.TrimSpace(invite)), []byte(configuredInvite)) != 1 {
		return authUser{}, false, os.ErrPermission
	}
	if password == "" || len(password) < 8 {
		return authUser{}, false, os.ErrInvalid
	}
	if email == "" || !strings.Contains(email, "@") {
		return authUser{}, false, os.ErrInvalid
	}
	if existing, ok := a.users[email]; ok {
		return existing, false, nil
	}
	id, err := randomHex(12)
	if err != nil {
		return authUser{}, false, err
	}
	salt, err := randomHex(16)
	if err != nil {
		return authUser{}, false, err
	}
	user := authUser{
		ID: id, Name: name, Email: email, Role: "Admin", Status: "active",
		PasswordSalt: salt, PasswordHash: passwordDigest(salt, password), CreatedAt: time.Now(),
	}
	a.users[email] = user
	if err := a.saveLocked(); err != nil {
		return authUser{}, false, err
	}
	return user, true, nil
}

func validateUserInput(name, email, password string) (string, string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	name = strings.TrimSpace(name)
	if name == "" {
		name = email
	}
	if password == "" || len(password) < 8 {
		return "", "", os.ErrInvalid
	}
	if email == "" || !strings.Contains(email, "@") {
		return "", "", os.ErrInvalid
	}
	return name, email, nil
}

func (a *authStore) createUser(name, email, password, role string) (authUser, error) {
	name, email, err := validateUserInput(name, email, password)
	if err != nil {
		return authUser{}, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, exists := a.users[email]; exists {
		return authUser{}, os.ErrExist
	}
	id, err := randomHex(12)
	if err != nil {
		return authUser{}, err
	}
	salt, err := randomHex(16)
	if err != nil {
		return authUser{}, err
	}
	user := authUser{
		ID: id, Name: name, Email: email, Role: normalizeRole(role), Status: "active",
		PasswordSalt: salt, PasswordHash: passwordDigest(salt, password), CreatedAt: time.Now(),
	}
	a.users[email] = user
	if err := a.saveLocked(); err != nil {
		delete(a.users, email)
		return authUser{}, err
	}
	return user, nil
}

func (a *authStore) activeAdminCountLocked() int {
	count := 0
	for _, user := range a.users {
		if user.Role == "Admin" && user.Status == "active" {
			count++
		}
	}
	return count
}

func (a *authStore) userByIDLocked(id string) (string, authUser, bool) {
	for email, user := range a.users {
		if user.ID == id {
			return email, user, true
		}
	}
	return "", authUser{}, false
}

func (a *authStore) updateUser(id, name, role, status, password string, actorID string) (authUser, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	email, user, ok := a.userByIDLocked(id)
	if !ok {
		return authUser{}, os.ErrNotExist
	}
	if id == actorID && (role != "" || status != "") {
		return authUser{}, os.ErrPermission
	}
	if name != "" {
		user.Name = strings.TrimSpace(name)
		if user.Name == "" {
			return authUser{}, os.ErrInvalid
		}
	}
	if role != "" {
		user.Role = normalizeRole(role)
	}
	if status != "" {
		status = strings.ToLower(strings.TrimSpace(status))
		if status != "active" && status != "disabled" {
			return authUser{}, os.ErrInvalid
		}
		user.Status = status
	}
	if password != "" {
		if len(password) < 8 {
			return authUser{}, os.ErrInvalid
		}
		salt, err := randomHex(16)
		if err != nil {
			return authUser{}, err
		}
		user.PasswordSalt = salt
		user.PasswordHash = passwordDigest(salt, password)
	}
	if user.Role != "Admin" || user.Status != "active" {
		wasLastAdmin := a.activeAdminCountLocked() == 1
		if wasLastAdmin {
			previous, exists := a.users[email]
			if exists && previous.Role == "Admin" && previous.Status == "active" {
				return authUser{}, os.ErrPermission
			}
		}
	}
	a.users[email] = user
	if err := a.saveLocked(); err != nil {
		return authUser{}, err
	}
	if password != "" {
		a.clearSessionsLocked(user.ID)
	}
	return user, nil
}

func (a *authStore) deleteUser(id, actorID string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if id == actorID {
		return os.ErrPermission
	}
	email, user, ok := a.userByIDLocked(id)
	if !ok {
		return os.ErrNotExist
	}
	if user.Role == "Admin" && user.Status == "active" && a.activeAdminCountLocked() <= 1 {
		return os.ErrPermission
	}
	delete(a.users, email)
	a.clearSessionsLocked(user.ID)
	if err := a.saveLocked(); err != nil {
		a.users[email] = user
		return err
	}
	return nil
}

func (a *authStore) authenticate(email, password string) (authUser, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	email = strings.ToLower(strings.TrimSpace(email))
	user, ok := a.users[email]
	if !ok || user.Status != "active" {
		return authUser{}, false
	}
	hash := passwordDigest(user.PasswordSalt, password)
	if subtle.ConstantTimeCompare([]byte(hash), []byte(user.PasswordHash)) != 1 {
		return authUser{}, false
	}
	user.LastLoginAt = time.Now()
	a.users[email] = user
	_ = a.saveLocked()
	return user, true
}

func (a *authStore) createSession(user authUser) (authSession, error) {
	token, err := randomHex(32)
	if err != nil {
		return authSession{}, err
	}
	session := authSession{Token: token, UserID: user.ID, ExpiresAt: time.Now().Add(14 * 24 * time.Hour)}
	a.mu.Lock()
	a.sessions[token] = session
	a.mu.Unlock()
	return session, nil
}

func (a *authStore) clearSession(token string) {
	a.mu.Lock()
	delete(a.sessions, token)
	a.mu.Unlock()
}

func (a *authStore) clearSessionsLocked(userID string) {
	for token, session := range a.sessions {
		if session.UserID == userID {
			delete(a.sessions, token)
		}
	}
}

func (a *authStore) userBySession(token string) (authUser, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	session, ok := a.sessions[token]
	if !ok || time.Now().After(session.ExpiresAt) {
		delete(a.sessions, token)
		return authUser{}, false
	}
	for _, user := range a.users {
		if user.ID == session.UserID && user.Status == "active" {
			return user, true
		}
	}
	return authUser{}, false
}

func (a *authStore) listUsers() []map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	records := make([]authUser, 0, len(a.users))
	for _, user := range a.users {
		records = append(records, user)
	}
	sort.Slice(records, func(i, j int) bool {
		if records[i].CreatedAt.Equal(records[j].CreatedAt) {
			return records[i].Email < records[j].Email
		}
		return records[i].CreatedAt.Before(records[j].CreatedAt)
	})
	users := make([]map[string]any, 0, len(records))
	for _, user := range records {
		users = append(users, publicUser(user))
	}
	return users
}

func setSessionCookie(w http.ResponseWriter, session authSession) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookieName, Value: session.Token, Path: "/",
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Expires: session.ExpiresAt,
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookieName, Value: "", Path: "/",
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Expires: time.Unix(0, 0), MaxAge: -1,
	})
}
