import test from 'node:test';
import assert from 'node:assert/strict';
import { createExposureSync } from './exposureSync.js';
test('old result cannot clear or overwrite a newer exposure request', () => {
 const s=createExposureSync(); s.submit('a',10); s.submit('b',20);
 assert.equal(s.finish({actionId:'a',status:'completed'}),false);
 assert.equal(s.pending.id,'b');
 assert.equal(s.finish({actionId:'b',status:'completed'}),true);
 assert.equal(s.finish({actionId:'b',status:'completed'}),false);
});
test('dragging blocks telemetry and completion updates', () => {
 const s=createExposureSync(); s.submit('a',10); s.begin();
 assert.equal(s.blocked(),true);
 assert.equal(s.finish({actionId:'a',status:'completed'}),false);
 assert.equal(s.blocked(),true);
 s.submit('b',20); assert.equal(s.finish({actionId:'b',status:'completed'}),true);
 assert.equal(s.blocked(),false);
});
test('stale errors and uncorrelated results do not release pending state', () => {
 const s=createExposureSync(); s.submit('b',20);
 assert.equal(s.fail('a'),false);
 assert.equal(s.finish({status:'completed'}),false);
 assert.equal(s.blocked(),true);
 assert.equal(s.fail('b'),true); assert.equal(s.blocked(),false);
});
