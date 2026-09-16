package web

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLegacyRolesMigrateToAdminAndUser(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users.json")
	createdAt := time.Now().Add(-time.Minute)
	legacy := map[string]authUser{
		"operator@example.com": {
			ID: "operator-id", Name: "操作员", Email: "operator@example.com",
			Role: "Operator", Status: "active", CreatedAt: createdAt,
		},
		"viewer@example.com": {
			ID: "viewer-id", Name: "访客", Email: "viewer@example.com",
			Role: "Viewer", Status: "active", CreatedAt: createdAt.Add(time.Second),
		},
		"admin@example.com": {
			ID: "admin-id", Name: "管理员", Email: "admin@example.com",
			Role: "Admin", Status: "active", CreatedAt: createdAt.Add(2 * time.Second),
		},
	}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}

	store := newAuthStore(path)
	users := store.listUsers()
	if len(users) != 3 {
		t.Fatalf("账户数量 = %d, want 3", len(users))
	}
	for _, user := range users {
		role, _ := user["role"].(string)
		if role != "Admin" && role != "User" {
			t.Fatalf("发现未迁移角色: %#v", user)
		}
		if _, exists := user["passwordHash"]; exists {
			t.Fatalf("公开账户资料不应包含密码摘要: %#v", user)
		}
	}
	if normalizeRole("Operator") != "User" || normalizeRole("Viewer") != "User" {
		t.Fatal("历史角色没有统一为普通用户")
	}
	if normalizeRole("Admin") != "Admin" {
		t.Fatal("管理员角色被错误转换")
	}
}

func TestAuthenticateAcceptsShortAccountName(t *testing.T) {
	store := newAuthStore(filepath.Join(t.TempDir(), "users.json"))
	created, err := store.createUser("蓝队", "team-blue@fish.local", "123456789", "User")
	if err != nil {
		t.Fatal(err)
	}

	shortAccount, ok := store.authenticate("team-blue", "123456789")
	if !ok || shortAccount.ID != created.ID {
		t.Fatalf("短账号登录失败: %#v, ok=%v", shortAccount, ok)
	}
	fullAccount, ok := store.authenticate("team-blue@fish.local", "123456789")
	if !ok || fullAccount.ID != created.ID {
		t.Fatalf("完整账号登录失败: %#v, ok=%v", fullAccount, ok)
	}
	if _, ok := store.authenticate("team-red", "123456789"); ok {
		t.Fatal("未建立的短账号不应登录成功")
	}
}
