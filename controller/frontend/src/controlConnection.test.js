import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const adapter = readFileSync(new URL("../public/competition/competition-adapter.js", import.meta.url), "utf8");

test("控制连接提前建立，空闲复用，断线恢复且不发送运动", async () => {
  const sockets = [];
  let interval;
  let now = 10000;
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 0; sockets.push(this); }
    close() { this.readyState = 3; this.onclose?.(); }
    send() { throw new Error("预连接不得发送运动"); }
  }
  const state = { authenticated: true };
  const begin = adapter.indexOf("  var controlSocket = null;");
  const end = adapter.indexOf("  var activePointers =", begin);
  const context = {
    state, WebSocket: Socket,
    window: { location: { protocol: "https:", host: "fish.test" }, setTimeout: () => 1, clearTimeout() {}, setInterval(callback) { interval = callback; return 1; }, clearInterval() {} },
    Date: { now: () => now },
    isRefereePage: () => false, ownsLoginTab: () => true, setBadge() {},
  };
  const actions = runInNewContext(adapter.slice(begin, end) + "\n({startControlConnection,stopControlConnection,ensureControlSocket})", context);
  actions.startControlConnection();
  assert.equal(sockets.length, 1);
  interval();
  assert.equal(sockets.length, 1);
  sockets[0].readyState = 1;
  sockets[0].onopen();
  await actions.ensureControlSocket();
  interval();
  assert.equal(sockets.length, 1);
  sockets[0].close();
  now += 2000;
  interval();
  assert.equal(sockets.length, 2);
  actions.stopControlConnection();
  state.authenticated = false;
  interval();
  assert.equal(sockets.length, 2);
  await new Promise((resolve) => setImmediate(resolve));
});
