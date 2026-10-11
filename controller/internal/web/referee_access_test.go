package web

import (
	"fish-controller/internal/hub"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestAccountsOpenOnlyTheirAssignedPage(t *testing.T) {
	t.Setenv("FISH_AUTH_DISABLED", "false")
	t.Setenv("FISH_AUTH_USERS", filepath.Join(t.TempDir(), "users.json"))
	t.Setenv("FISH_COMPETITION_STATE", filepath.Join(t.TempDir(), "competition.json"))
	store := newAuthStore(authStorePath())
	for _, account := range []struct{ name, login, role string }{
		{"蓝队", "1", "User"}, {"红队", "2", "User"},
		{"裁判", "3", "Admin"}, {"其他管理员", "4", "Admin"},
	} {
		if _, err := store.createUser(account.name, account.login, account.login, account.role); err != nil {
			t.Fatal(err)
		}
	}
	handler := NewHandler(hub.New(), testKey())
	refereePage := "/competition/referee_interface.html"
	playerPage := "/competition/player_interface.html"
	for _, page := range []string{refereePage, playerPage} {
		unauthenticated := httptest.NewRecorder()
		handler.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, page, nil))
		if unauthenticated.Code != http.StatusUnauthorized {
			t.Fatalf("未登录访问 %s 应返回 401，实际 %d", page, unauthenticated.Code)
		}
	}
	for _, account := range []struct {
		login, page string
		status      int
	}{
		{"1", refereePage, http.StatusForbidden}, {"2", refereePage, http.StatusForbidden},
		{"3", refereePage, http.StatusOK}, {"4", refereePage, http.StatusForbidden},
		{"1", playerPage, http.StatusOK}, {"2", playerPage, http.StatusOK},
		{"3", playerPage, http.StatusForbidden}, {"4", playerPage, http.StatusForbidden},
	} {
		login := httptest.NewRecorder()
		handler.ServeHTTP(login, httptest.NewRequest(http.MethodPost, "/api/auth/login",
			strings.NewReader(`{"email":"`+account.login+`","password":"`+account.login+`"}`)))
		if login.Code != http.StatusOK {
			t.Fatalf("账号 %s 登录失败: %d", account.login, login.Code)
		}
		request := httptest.NewRequest(http.MethodGet, account.page, nil)
		for _, cookie := range login.Result().Cookies() {
			request.AddCookie(cookie)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != account.status {
			t.Fatalf("账号 %s 访问裁判端得到 %d，预期 %d", account.login, response.Code, account.status)
		}
		if account.status != http.StatusOK && strings.Contains(response.Body.String(), "<html") {
			t.Fatalf("账号 %s 收到了未授权页面内容", account.login)
		}
		if account.page == refereePage {
			operation := httptest.NewRequest(http.MethodPost, "/api/competition/match/match", strings.NewReader(`{}`))
			for _, cookie := range login.Result().Cookies() {
				operation.AddCookie(cookie)
			}
			operationResponse := httptest.NewRecorder()
			handler.ServeHTTP(operationResponse, operation)
			if operationResponse.Code != account.status {
				t.Fatalf("账号 %s 执行裁判操作得到 %d，预期 %d", account.login, operationResponse.Code, account.status)
			}
		}
	}
}

func TestAdminConsoleIsRestrictedToNonRefereeAdmins(t *testing.T) {
	t.Setenv("FISH_AUTH_DISABLED", "false")
	t.Setenv("FISH_AUTH_USERS", filepath.Join(t.TempDir(), "users.json"))
	t.Setenv("FISH_FRONTEND_DIR", "")
	store := newAuthStore(authStorePath())
	for _, account := range []struct{ name, login, role string }{
		{"裁判", "3", "Admin"}, {"管理员", "4", "Admin"}, {"选手", "1", "User"},
	} {
		if _, err := store.createUser(account.name, account.login, account.login, account.role); err != nil {
			t.Fatal(err)
		}
	}
	handler := NewHandler(hub.New(), testKey())
	for _, account := range []struct {
		login  string
		status int
	}{
		{"3", http.StatusForbidden}, {"4", http.StatusOK}, {"1", http.StatusForbidden},
	} {
		login := httptest.NewRecorder()
		handler.ServeHTTP(login, httptest.NewRequest(http.MethodPost, "/api/auth/login",
			strings.NewReader(`{"email":"`+account.login+`","password":"`+account.login+`"}`)))
		if login.Code != http.StatusOK {
			t.Fatalf("账号 %s 登录失败: %d", account.login, login.Code)
		}
		server := httptest.NewServer(handler)
		client := server.Client()
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		httpRequest, err := http.NewRequest(http.MethodGet, server.URL+"/console.html", nil)
		if err != nil {
			server.Close()
			t.Fatal(err)
		}
		httpRequest.AddCookie(login.Result().Cookies()[0])
		response, err := client.Do(httpRequest)
		if err != nil {
			server.Close()
			t.Fatal(err)
		}
		if response.StatusCode != account.status {
			t.Fatalf("账号 %s 访问管理控制台得到 %d，预期 %d，Location=%q", account.login, response.StatusCode, account.status, response.Header.Get("Location"))
		}
		if account.login == "4" {
			body, readErr := io.ReadAll(response.Body)
			if readErr != nil {
				server.Close()
				t.Fatal(readErr)
			}
			response.Body.Close()
			if !strings.Contains(string(body), "console-") {
				server.Close()
				t.Fatal("管理员访问没有返回管理控制台页面")
			}
		} else {
			response.Body.Close()
		}
		server.Close()
	}
}

func TestSecondMachineLoginRevokesFirstMachine(t *testing.T) {
	t.Setenv("FISH_AUTH_DISABLED", "false")
	t.Setenv("FISH_AUTH_USERS", filepath.Join(t.TempDir(), "users.json"))
	store := newAuthStore(authStorePath())
	if _, err := store.createUser("蓝队", "1", "1", "User"); err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(hub.New(), testKey())
	login := func() *http.Cookie {
		t.Helper()
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"email":"1","password":"1"}`)))
		if response.Code != http.StatusOK || len(response.Result().Cookies()) == 0 {
			t.Fatalf("登录失败: %d %s", response.Code, response.Body.String())
		}
		return response.Result().Cookies()[0]
	}
	first := login()
	second := login()
	check := func(cookie *http.Cookie) bool {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
		request.AddCookie(cookie)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return strings.Contains(response.Body.String(), `"authenticated":true`)
	}
	if check(first) || !check(second) {
		t.Fatal("第二台机器登录后，旧会话应失效，新会话应有效")
	}
}
