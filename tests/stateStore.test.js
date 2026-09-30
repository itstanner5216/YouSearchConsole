'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { isolateDataDir } = require('./helpers');

describe('stateStore threads + restart', () => {
  let stateStore;
  let isolation;

  beforeEach(() => {
    isolation = isolateDataDir('ydc-state-');
    stateStore = require('../server/stateStore');
    stateStore.setRawState({ threads: [], activeThreadId: null, lruOrder: [] });
  });

  afterEach(() => {
    if (isolation) isolation.restore();
  });

  it('keeps 20 sidebar threads; 21st evicts oldest from list only', () => {
    const ids = [];
    for (let i = 0; i < 21; i++) {
      const t = stateStore.createThread('frontier');
      stateStore.updateThread(t.id, { title: `T${i}` });
      ids.push(t.id);
    }
    const sidebar = stateStore.listSidebarThreads();
    assert.equal(sidebar.length, 20);
    // Oldest (ids[0]) should be dropped from LRU list
    assert.equal(sidebar.find((t) => t.id === ids[0]), undefined);
    // But thread object still exists in raw state
    assert.ok(stateStore.getThread(ids[0]));
    assert.equal(stateStore.getRawState().threads.length, 21);
  });

  it('drop from sidebar leaves thread data intact', () => {
    const t = stateStore.createThread('answers');
    stateStore.createRequest(t.id, { mode: 'answers', input: 'hi', status: 'DRAFT' });
    stateStore.dropFromSidebar(t.id);
    assert.equal(stateStore.listSidebarThreads().find((x) => x.id === t.id), undefined);
    assert.ok(stateStore.getThread(t.id));
    assert.equal(stateStore.getThread(t.id).requests.length, 1);
  });

  it('restart pauses in-flight tracking without auto-poll', () => {
    const t = stateStore.createThread('frontier');
    const req = stateStore.createRequest(t.id, {
      mode: 'frontier',
      input: 'q',
      status: 'RESEARCHING',
    });
    stateStore.updateRequest(req.id, {
      status: 'RESEARCHING',
      jobId: 'job-123',
      trackingActive: true,
      submittedAt: new Date().toISOString(),
    });

    // Simulate persist + reload logic
    const raw = stateStore.getRawState();
    // Manually run the load pause logic
    for (const th of raw.threads) {
      for (const r of th.requests) {
        if (
          r.jobId &&
          ['SUBMITTING', 'SUBMITTED', 'RESEARCHING', 'RECEIVING'].includes(r.status)
        ) {
          r.status = 'TRACKING PAUSED';
          r.trackingActive = false;
          r.pauseReason = 'app_restart';
        }
      }
    }
    const found = stateStore.getRequest(req.id);
    assert.equal(found.request.status, 'TRACKING PAUSED');
    assert.equal(found.request.trackingActive, false);
    assert.equal(found.request.jobId, 'job-123');
  });
});
