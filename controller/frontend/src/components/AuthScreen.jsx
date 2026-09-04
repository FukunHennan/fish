import { useState } from "react";

export default function AuthScreen({ onAuthenticated, bootstrap }) {
  const [mode, setMode] = useState(bootstrap ? "bootstrap" : "login");
  const [name, setName] = useState("陈富坤");
  const [email, setEmail] = useState("chenfukun@example.com");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [feedback, setFeedback] = useState("电脑端控制台，请使用本地账号登录。");
  const [busy, setBusy] = useState(false);

  async function submitAuth(event) {
    event.preventDefault();
    if (busy) return;
    if (mode === "bootstrap" && password !== confirmPassword) {
      setFeedback("两次密码不一致");
      return;
    }
    setBusy(true);
    setFeedback(mode === "login" ? "正在登录…" : "正在创建管理员账户…");
    try {
      const response = await fetch(mode === "login" ? "/api/auth/login" : "/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "login" ? { email, password } : { name, email, password }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.authenticated === false) {
        throw new Error(result.message || (mode === "login" ? "登录失败" : "管理员账户创建失败"));
      }
      onAuthenticated(result.user);
    } catch (authError) {
      setFeedback(authError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page" data-mode={mode}>
      <div className="auth-frame">
        <div className="auth-browser-bar" aria-hidden="true">
          <span className="auth-lamp" /><span className="auth-lamp" /><span className="auth-lamp" />
          <span className="auth-url">fish.chenfukun.space/login</span>
        </div>
        <div className="auth-screen">
          <section className="auth-side">
            <div className="auth-brand">
              <div className="auth-logo">鱼</div>
              <div><small>FISH CONTROL</small><strong>多鱼控制平台</strong></div>
            </div>
            <div className="auth-copy-main">
              <h1>安全进入控制台</h1>
              <p>登录只保留必要信息。通过身份校验后，才显示手动、视觉、设置界面，并记录每条鱼的控制者。</p>
            </div>
            <div className="auth-side-bottom">
              <div className="auth-mini-pond" aria-label="Fish status preview">
                <div className="auth-fish-dot">鱼 A</div><div className="auth-fish-dot">鱼 B</div><div className="auth-fish-dot">鱼 C</div>
              </div>
              <div className="auth-pills"><span><i />Cloudflare</span><span>多条鱼在线</span><span>控制互斥</span></div>
            </div>
          </section>
          <section className="auth-card" aria-label={bootstrap ? "登录或初始化管理员" : "登录"}>
            {bootstrap && <div className="auth-tabs" role="tablist" aria-label="Login or administrator bootstrap">
              <button className={mode === "login" ? "active" : ""} aria-selected={mode === "login"} type="button" onClick={() => setMode("login")}>登录</button>
              <button className={mode === "bootstrap" ? "active" : ""} aria-selected={mode === "bootstrap"} type="button" onClick={() => setMode("bootstrap")}>初始化管理员</button>
            </div>}
            <div className="auth-form-head">
              <h2>{mode === "login" ? "登录账号" : "创建管理员账户"}</h2>
              <p>{mode === "login" ? (bootstrap ? "系统尚未初始化；也可以先创建首个管理员账户。" : "账户由管理员创建和管理，请使用已有账号登录。") : "首次启动时创建唯一的初始管理员；之后所有账户都必须由管理员建立。"}</p>
            </div>
            <form className="auth-form" onSubmit={submitAuth}>
              {mode === "login" && <>
                <button className="auth-primary" type="button" onClick={() => setFeedback("Cloudflare Access 入口已预留；如果要正式启用，我下一步可以接 Cloudflare Zero Trust。")}>使用 Cloudflare Access 登录</button>
                <div className="auth-divider">或使用本地账号</div>
              </>}
              {mode === "bootstrap" ? <div className="auth-two-col">
                <label className="auth-field"><span>姓名</span><input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label>
                <label className="auth-field"><span>邮箱</span><input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>
              </div> : <label className="auth-field"><span>邮箱</span><input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>}
              {mode === "bootstrap" ? <div className="auth-two-col">
                <label className="auth-field"><span>设置密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></label>
                <label className="auth-field"><span>确认密码</span><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" /></label>
              </div> : <label className="auth-field"><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>}
              {mode === "login" && <div className="auth-helper-row"><label className="auth-check"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> 保持登录</label><button type="button" onClick={() => setFeedback("当前版本还没有接入找回密码；管理员可以在服务器端重置账号。")}>忘记密码</button></div>}
              <button className={mode === "login" ? "auth-secondary" : "auth-primary"} disabled={busy}>{busy ? "请稍候…" : mode === "login" ? "进入控制台" : "创建管理员并进入"}</button>
              <p className="auth-feedback" aria-live="polite">{feedback}</p>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}
