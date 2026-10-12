import test from "node:test";
import assert from "node:assert/strict";
import { batteryLevel, batteryVoltage } from "./ui/devicePresentation.js";

test("0% remains a valid battery reading without requiring a voltage value", () => {
  assert.equal(batteryLevel({ batteryPercent: 0, batteryAtMs: 10 }), 0);
  assert.equal(batteryLevel({ batteryPercent: 0 }), null);
  assert.equal(batteryVoltage({ batteryVoltage: 3.126 }), "3.13 V");
  assert.equal(batteryVoltage({ batteryVoltage: 0 }), "电压 —");
});
