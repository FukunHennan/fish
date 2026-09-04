import test from 'node:test';
import assert from 'node:assert/strict';
import { startLeaseRenewal } from './leaseRenewal.js';
test('held control renews beyond 60 seconds and stops after release', async () => {
  let tick, target = { deviceId: 'fish' }, calls = 0, cancelled = false;
  const stop = startLeaseRenewal({getTarget: () => target, renew: async () => calls++, onError: assert.fail,
    schedule: (fn, ms) => { tick = fn; assert.equal(ms, 15000); return 1; }, cancel: () => { cancelled = true; }});
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(calls, 6);
  target = null;
  await tick();
  assert.equal(calls, 6);
  stop(); assert.equal(cancelled, true);
});
test('renewal has no overlapping requests and failure stops current control', async () => {
  let tick, reject, errors = 0, calls = 0;
  const stop = startLeaseRenewal({getTarget: () => ({deviceId: 'fish'}),
    renew: () => { calls++; return new Promise((_, r) => {reject = r;}); }, onError: () => errors++,
    schedule: fn => {tick = fn;}, cancel: () => {}});
  const pending = tick(); await tick(); assert.equal(calls, 1);
  reject(new Error('lost lease')); await pending; assert.equal(errors, 1);
  stop(); await tick(); assert.equal(calls, 1);
});
