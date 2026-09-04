import test from "node:test";
import assert from "node:assert/strict";
import { CONTROL_CLIENT_ID, leaseIsMine } from "./ui/devicePresentation.js";
import { deviceStateSignature } from "./deviceState.js";

test("同一账号的不同浏览器不能共用控制权", () => {
  const user = { id: "user" };
  assert.equal(leaseIsMine({ ownerId: "user", clientId: CONTROL_CLIENT_ID }, user), true);
  assert.equal(leaseIsMine({ ownerId: "user", clientId: "other-browser" }, user), false);
});

test("浏览器接管变化会触发设备快照更新", () => {
  const device = { deviceId: "fish", lease: { ownerId: "user", clientId: "a" } };
  assert.notEqual(deviceStateSignature([device]), deviceStateSignature([{ ...device, lease: { ...device.lease, clientId: "b" } }]));
});
