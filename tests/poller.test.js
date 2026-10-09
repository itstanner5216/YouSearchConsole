'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const poller = require('../server/poller');

describe('poller schedule', () => {
  it('uses 30s in first 3 minutes', () => {
    assert.equal(poller.getInterval(0).intervalMs, 30000);
    assert.equal(poller.getInterval(2 * 60 * 1000).intervalMs, 30000);
    assert.equal(poller.getInterval(3 * 60 * 1000 - 1).intervalMs, 30000);
  });

  it('uses 15s between 3 and 6 minutes', () => {
    assert.equal(poller.getInterval(3 * 60 * 1000).intervalMs, 15000);
    assert.equal(poller.getInterval(5 * 60 * 1000).intervalMs, 15000);
  });

  it('uses 30s between 6 and 15 minutes', () => {
    assert.equal(poller.getInterval(6 * 60 * 1000).intervalMs, 30000);
    assert.equal(poller.getInterval(15 * 60 * 1000 - 1).intervalMs, 30000);
    assert.equal(poller.getInterval(15 * 60 * 1000 - 1).exhausted, false);
  });

  it('exhausts at the 15 minute failsafe', () => {
    const r = poller.getInterval(15 * 60 * 1000);
    assert.equal(r.exhausted, true);
    assert.equal(r.intervalMs, 0);
  });

  it('computeSchedule agrees on elapsed / interval / next check', () => {
    const submitted = Date.now() - 90 * 1000; // 1.5 min in
    const now = Date.now();
    const last = now - 10 * 1000; // last check 10s ago; interval 30s → next in 20s
    const s = poller.computeSchedule(submitted, now, last);
    assert.equal(s.intervalMs, 30000);
    assert.ok(s.elapsedMs >= 90 * 1000);
    assert.ok(s.nextCheckMs >= 19000 && s.nextCheckMs <= 21000);
    assert.equal(s.exhausted, false);
  });

  it('computeSchedule marks exhausted past failsafe', () => {
    const now = Date.now();
    assert.equal(poller.computeSchedule(now - 14 * 60 * 1000, now, null).exhausted, false);
    assert.equal(poller.computeSchedule(now - 16 * 60 * 1000, now, null).exhausted, true);
  });
});
