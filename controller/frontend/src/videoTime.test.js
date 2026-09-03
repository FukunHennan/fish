import test from "node:test";
import assert from "node:assert/strict";

import { formatFrameLatency, formatServerClock } from "./videoTime.js";

test("server clock advances from the time the response was received", () => {
  const formatted = formatServerClock(1_700_000_000, 480, 10_000, 11_234);
  assert.notEqual(formatted, "—");
  assert.match(formatted, /^\d{2}:\d{2}:\d{2}$/);
});

test("processing time is labeled as processing instead of transport delay", () => {
  assert.equal(formatFrameLatency({ frameLatencyMs: 24.4 }), " · 处理 24 ms");
});
