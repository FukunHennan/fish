import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const page = readFileSync(new URL("../competition.html", import.meta.url), "utf8");
const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];

test("旧会话检查不会在账号 3 登录后再次打开登录页", async () => {
  assert.ok(script);
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: id === "loginGate", value: "", textContent: "", disabled: false,
      classList: { toggle() {} }, focus() {},
    });
    return elements.get(id);
  };
  element("accountInput").value = "3";
  element("passwordInput").value = "3";
  let resolveOldCheck;
  const oldCheck = new Promise((resolve) => { resolveOldCheck = resolve; });
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const user = { id: "referee-id", email: "3", role: "Admin" };
  runInNewContext(script, {
    document: { getElementById: element, addEventListener() {}, hidden: false },
    window: { addEventListener() {} },
    location: { origin: "http://localhost" },
    sessionStorage: storage,
    localStorage: storage,
    setInterval() {},
    fetch(path) {
      if (path === "/api/auth/me") return oldCheck;
      if (path === "/api/auth/login") return Promise.resolve({ ok: true, json: async () => ({ authenticated: true, user }) });
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  await element("loginForm").onsubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element("loginGate").hidden, true);
  assert.equal(element("appFrame").src, "/competition/referee_interface.html");
  resolveOldCheck({ ok: true, json: async () => ({ authenticated: false }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element("loginGate").hidden, true);
  assert.equal(element("appFrame").src, "/competition/referee_interface.html");
});
