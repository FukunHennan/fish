import { useEffect, useState } from "react";
import { formatTime, roleLabel } from "../ui/devicePresentation.js";

export default function AdminUsers({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "User" });
  const [drafts, setDrafts] = useState({});
  const [feedback, setFeedback] = useState("正在读取账户…");
  const [busy, setBusy] = useState(false);

  async function loadUsers() {
    const response = await fetch("/api/auth/users", { cache: "no-store" });
    const result = await response.json().catch(() => []);
    if (!response.ok) throw new Error(result.message || "无法读取账户");
    const next = Array.isArray(result) ? result : [];
    setUsers(next);
    setDrafts(Object.fromEntries(next.map((user) => [user.id, {
      name: user.name,
      role: user.role || "User",
      status: user.status || "active",
      password: "",
    }])));
  }

  useEffect(() => {
    loadUsers().then(() => setFeedback("账户由管理员统一管理")).catch((error) => setFeedback(error.message));
  }, []);

  function updateDraft(id, key, value) {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], [key]: value } }));
  }

  async function createUser(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFeedback("正在创建账户…");
    try {
      const response = await fetch("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "创建账户失败");
      setForm({ name: "", email: "", password: "", role: "User" });
      await loadUsers();
      setFeedback(`已创建 ${result.user?.email || "新账户"}`);
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveUser(user) {
    const draft = drafts[user.id];
    if (!draft || busy) return;
    setBusy(true);
    setFeedback(`正在保存 ${user.email}…`);
    try {
      const payload = { id: user.id, name: draft.name };
      if (user.id !== currentUser?.id) {
        payload.role = draft.role;
        payload.status = draft.status;
      }
      if (draft.password) payload.password = draft.password;
      const response = await fetch("/api/auth/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "保存账户失败");
      await loadUsers();
      setFeedback(`已保存 ${result.user?.email || user.email}`);
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteUser(user) {
    if (busy || user.id === currentUser?.id || !window.confirm(`确定删除账户 ${user.email}？该操作不可撤销。`)) return;
    setBusy(true);
    setFeedback(`正在删除 ${user.email}…`);
    try {
      const response = await fetch("/api/auth/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: user.id }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "删除账户失败");
      await loadUsers();
      setFeedback(`已删除 ${user.email}`);
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="settings-card admin-users-card">
      <div className="admin-users-heading">
        <div><span className="eyebrow">ADMINISTRATION</span><h2>账户管理</h2><small>管理员可以查看和处理普通用户账户；密码不会以明文显示。</small></div>
        <span className="status online"><i />管理员 {users.filter((user) => user.role === "Admin").length} · 普通用户 {users.filter((user) => user.role !== "Admin").length}</span>
      </div>
      <form className="admin-create-form" onSubmit={createUser}>
        <label className="setting"><span>姓名</span><input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="例如：张三" required /></label>
        <label className="setting"><span>邮箱</span><input type="email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} placeholder="name@example.com" required /></label>
        <label className="setting"><span>初始密码</span><input type="password" minLength="8" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} placeholder="至少 8 位" required /></label>
        <label className="setting"><span>账户类型</span><select value={form.role} onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))}><option value="User">普通用户：可以使用控制台</option><option value="Admin">管理员：可以管理账户</option></select></label>
        <button className="action" disabled={busy}>创建账户</button>
      </form>
      <div className="admin-user-list">
        {users.map((user) => {
          const draft = drafts[user.id] || { name: user.name, role: user.role || "User", status: user.status || "active", password: "" };
          const isSelf = user.id === currentUser?.id;
          return <div className="admin-user-row" key={user.id}>
            <div className="admin-user-identity"><strong>{user.name || user.email}</strong><small>{user.email} · {roleLabel(user)}{user.createdAt ? ` · 创建于 ${formatTime(user.createdAt)}` : ""}{user.lastLoginAt ? ` · 最近登录 ${formatTime(user.lastLoginAt)}` : ""}</small></div>
            <label className="setting"><span>姓名</span><input value={draft.name} onChange={(event) => updateDraft(user.id, "name", event.target.value)} /></label>
            <label className="setting"><span>账户类型</span><select value={draft.role} disabled={isSelf || busy} onChange={(event) => updateDraft(user.id, "role", event.target.value)}><option value="User">普通用户</option><option value="Admin">管理员</option></select></label>
            <label className="setting"><span>状态</span><select value={draft.status} disabled={isSelf || busy} onChange={(event) => updateDraft(user.id, "status", event.target.value)}><option value="active">启用</option><option value="disabled">停用</option></select></label>
            <label className="setting"><span>重置密码</span><input type="password" minLength="8" value={draft.password} disabled={isSelf || busy} placeholder={isSelf ? "当前账户不可操作" : "留空表示不修改"} onChange={(event) => updateDraft(user.id, "password", event.target.value)} /></label>
            <div className="admin-user-actions"><button className="action" type="button" disabled={busy} onClick={() => saveUser(user)}>保存</button><button className="danger" type="button" disabled={busy || isSelf} onClick={() => deleteUser(user)}>删除</button></div>
          </div>;
        })}
        {!users.length && <div className="list-row"><strong>暂无账户</strong><span>创建第一个受管理账户。</span></div>}
      </div>
      <p className="feedback" aria-live="polite">{feedback}</p>
    </article>
  );
}
