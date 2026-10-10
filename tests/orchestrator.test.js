'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const youClient = require('../server/youClient');
const envKey = require('../server/envKey');
const settings = require('../server/settings');
const stateStore = require('../server/stateStore');
const orchestrator = require('../server/orchestrator');
const { mockFetchSequence, isolateDataDir } = require('./helpers');

describe('orchestrator tracking + notify timing', () => {
  let outDir;
  let isolation;

  let envFile;
  let prevEnvPath;
  let prevApiKey;

  beforeEach(() => {
    isolation = isolateDataDir('ydc-orch-');
    outDir = isolation.outputDir;
    settings.update({ outputDir: outDir });
    stateStore.setRawState({ threads: [], activeThreadId: null, lruOrder: [] });

    prevEnvPath = process.env.YDC_ENV_PATH;
    prevApiKey = process.env.YDC_API_KEY;
    delete process.env.YDC_API_KEY;
    envFile = path.join(isolation.dataDir, '.env');
    fs.writeFileSync(envFile, '', 'utf8');
    process.env.YDC_ENV_PATH = envFile;
    envKey.rebindPaths({ envPath: envFile });
    envKey.setKey('test-key-orchestrator-0001');

    youClient.resetFetch();
    // Clear any leftover timers
    for (const id of [...orchestrator.timers.keys()]) {
      orchestrator.clearTimers(id);
    }
  });

  afterEach(() => {
    for (const id of [...orchestrator.timers.keys()]) {
      orchestrator.clearTimers(id);
    }
    youClient.resetFetch();
    try {
      envKey.deleteKey();
    } catch (_) {}
    try {
      envKey.rebindPaths({});
    } catch (_) {}
    if (prevEnvPath === undefined) delete process.env.YDC_ENV_PATH;
    else process.env.YDC_ENV_PATH = prevEnvPath;
    if (prevApiKey === undefined) delete process.env.YDC_API_KEY;
    else process.env.YDC_API_KEY = prevApiKey;
    if (isolation) isolation.restore();
  });

  // A research request You.com has accepted, submitted `agoMs` ago and still being tracked.
  function trackedRequest(agoMs) {
    const thread = stateStore.createThread('frontier');
    const req = stateStore.createRequest(thread.id, { mode: 'frontier', input: 'q', status: 'RESEARCHING' });
    stateStore.updateRequest(req.id, {
      status: 'RESEARCHING',
      jobId: 'task-tracked-1',
      trackingActive: true,
      submittedAt: new Date(Date.now() - agoMs).toISOString(),
    });
    return req.id;
  }
  const MIN = 60 * 1000;
  const current = (id) => stateStore.getRequest(id).request;

  it('keeps tracking a running job until the failsafe; there is no pause', async () => {
    youClient.setFetch(mockFetchSequence([{ status: 200, body: { task_id: 'task-tracked-1', status: 'running' } }]));
    const id = trackedRequest(10 * MIN);
    await orchestrator.doPoll(id);
    assert.equal(current(id).status, 'RESEARCHING');
    assert.equal(current(id).trackingActive, true);
    assert.equal(current(id).schedule.intervalMs, 30000);
    assert.ok(orchestrator.timers.has(id));
    assert.equal(orchestrator.inFlightCount(), 1);
  });

  it('retries a transient poll error on the schedule', async () => {
    youClient.setFetch(mockFetchSequence([{ status: 503, body: { message: 'Service Unavailable' } }]));
    const id = trackedRequest(60 * 1000);
    await orchestrator.doPoll(id);
    assert.equal(current(id).status, 'RESEARCHING');
    assert.equal(current(id).trackingActive, true);
    assert.ok(orchestrator.timers.has(id));
  });

  it('ends tracking when You.com no longer knows the job', async () => {
    youClient.setFetch(mockFetchSequence([{ status: 404, body: { message: 'Task not found' } }]));
    const id = trackedRequest(60 * 1000);
    await orchestrator.doPoll(id);
    assert.equal(current(id).status, 'FAILED');
    assert.equal(current(id).trackingActive, false);
    assert.equal(current(id).error.title, 'Research job not found');
    assert.equal(current(id).error.message, 'Task not found');
    assert.ok(!orchestrator.timers.has(id));
    assert.equal(orchestrator.inFlightCount(), 0);
  });

  it('past the 15 minute failsafe makes one last check: still running ends as timed out', async () => {
    youClient.setFetch(mockFetchSequence([{ status: 200, body: { task_id: 'task-tracked-1', status: 'running' } }]));
    const id = trackedRequest(15 * MIN + 1000);
    await orchestrator.doPoll(id);
    assert.equal(current(id).status, 'FAILED');
    assert.equal(current(id).trackingActive, false);
    assert.equal(current(id).error.title, 'Research timed out');
    assert.equal(current(id).error.message, 'You.com still had the job running after 15 minutes, so the app stopped waiting for it.');
    assert.ok(!orchestrator.timers.has(id));
  });

  it('past the 15 minute failsafe makes one last check: a finished report is still saved', async () => {
    youClient.setFetch(
      mockFetchSequence([
        { status: 200, body: { task_id: 'task-tracked-1', status: 'completed', result: { output: { content: '# Late', content_type: 'text' } } } },
      ])
    );
    const id = trackedRequest(60 * MIN);
    orchestrator.scheduleNextPoll(id);
    for (let i = 0; i < 50 && current(id).status !== 'SAVED · VERIFIED'; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(current(id).status, 'SAVED · VERIFIED');
    assert.equal(fs.readFileSync(current(id).savedPaths[0].path, 'utf8'), '# Late');
  });

  it('shows a failed job\'s error as text, never [object Object]', async () => {
    youClient.setFetch(
      mockFetchSequence([
        { status: 200, body: { status: 'failed', error: { message: 'Quota exceeded', code: 'quota' } } },
        { status: 200, body: { status: 'failed', error: { code: 'E42' } } },
      ])
    );
    const a = trackedRequest(60 * 1000);
    await orchestrator.doPoll(a);
    assert.equal(current(a).error.message, 'Quota exceeded');
    const b = trackedRequest(60 * 1000);
    await orchestrator.doPoll(b);
    assert.equal(current(b).error.message, '{"code":"E42"}');
  });

  it('picks up tracking for in-flight jobs on startup', () => {
    const id = trackedRequest(2 * 60 * 1000);
    const done = trackedRequest(2 * 60 * 1000);
    stateStore.updateRequest(done, { status: 'SAVED · VERIFIED', trackingActive: false });
    orchestrator.trackInFlight();
    assert.ok(orchestrator.timers.has(id));
    assert.ok(!orchestrator.timers.has(done));
    assert.equal(orchestrator.inFlightCount(), 1);
  });

  it('on startup, work cut off by the stop no longer holds its thread', async () => {
    const thread = stateStore.createThread('frontier');
    const make = (fields) => stateStore.createRequest(thread.id, { input: 'q', ...fields }).id;
    const streaming = make({ provider: 'jina', mode: 'high', status: 'RESEARCHING' });
    stateStore.updateRequest(streaming, { submittedAt: new Date().toISOString() });
    const unconfirmed = make({ provider: 'exa', mode: 'high', status: 'SUBMITTING' });
    const unanswered = make({ provider: 'keenable', mode: 'search', status: 'SUBMITTED' });
    const arrived = make({ provider: 'tavily', mode: 'pro', status: 'SAVING' });
    stateStore.updateRequest(arrived, { content: '# Arrived before the stop' });

    orchestrator.trackInFlight();
    await orchestrator.settle();

    const err = (id) => [current(id).status, current(id).error.title, current(id).error.message];
    assert.deepEqual(err(streaming), ['FAILED', 'Research interrupted', "The app stopped while Jina's report was streaming in; a streamed run can't be picked up again."]);
    assert.deepEqual(err(unconfirmed), ['FAILED', 'Research interrupted', "The app stopped before Exa confirmed it had the request, so it can't be picked up again."]);
    assert.deepEqual(err(unanswered), ['FAILED', 'Research interrupted', "The app stopped before Keenable's answer came in, so this request can't be picked up again."]);
    assert.equal(current(arrived).status, 'SAVED · VERIFIED');
    assert.equal(orchestrator.inFlightCount(), 0);
  });

  it('completes research, saves verified, sets notifyPending after verification', async () => {
    const md = '# Report\n\nExact bytes ✨\n';
    youClient.setFetch(
      mockFetchSequence([
        {
          status: 200,
          body: {
            task_id: 'task-done-1',
            status: 'queued',
            type: 'research',
            created_at: new Date().toISOString(),
          },
        },
        {
          status: 200,
          body: {
            task_id: 'task-done-1',
            status: 'completed',
            result: {
              output: {
                content: md,
                content_type: 'text',
                sources: [{ url: 'https://example.com', title: 'Ex' }],
              },
            },
          },
        },
      ])
    );

    const thread = stateStore.createThread('frontier');
    const req = await orchestrator.submit({
      threadId: thread.id,
      mode: 'frontier',
      input: 'finish me',
    });

    // Force immediate poll
    await orchestrator.doPoll(req.id);

    const final = stateStore.getRequest(req.id).request;
    assert.equal(final.status, 'SAVED · VERIFIED');
    assert.equal(final.content, md);
    assert.ok(final.savedPaths.length >= 1);
    assert.equal(fs.readFileSync(final.savedPaths[0].path, 'utf8'), md);
    assert.equal(final.notifyPending, true); // notification only after verification
  });

  it('answers and contents extract structured responses', async () => {
    youClient.setFetch(
      mockFetchSequence([
        {
          status: 200,
          body: { answer: 'Forty-two', citations: [{ source: 'https://x.com' }], results: [] },
        },
      ])
    );
    const t1 = stateStore.createThread('answers');
    const a = await orchestrator.submit({
      threadId: t1.id,
      mode: 'answers',
      input: 'What is the answer?',
    });
    assert.equal(a.content, 'Forty-two');
    assert.equal(a.status, 'SAVED · VERIFIED');
    assert.equal(a.rawResponse.answer, 'Forty-two');

    youClient.setFetch(
      mockFetchSequence([
        {
          status: 200,
          body: [
            { url: 'https://a.com', title: 'A', markdown: '# A page' },
            { url: 'https://b.com', title: 'B', markdown: '# B page' },
          ],
        },
      ])
    );
    const t2 = stateStore.createThread('contents');
    const c = await orchestrator.submit({
      threadId: t2.id,
      mode: 'contents',
      input: '',
      urls: ['https://a.com', 'https://b.com'],
    });
    assert.equal(c.status, 'SAVED · VERIFIED');
    assert.equal(c.contentsPages.length, 2);
    assert.equal(c.savedPaths.length, 2);
    assert.ok(c.savedPaths[0].path.includes('-01.md'));
    assert.ok(c.savedPaths[1].path.includes('-02.md'));
    assert.equal(fs.readFileSync(c.savedPaths[0].path, 'utf8'), '# A page');
  });

  it('save failure yields RECEIVED · SAVE FAILED; Save Again recovers', async () => {
    youClient.setFetch(
      mockFetchSequence([
        {
          status: 200,
          body: { answer: 'Keep me', citations: [], results: [] },
        },
      ])
    );
    // Read-only directory (mkdir under /proc can hang on some kernels)
    const roDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ydc-ro-'));
    fs.chmodSync(roDir, 0o555);

    // Bypass settings.validate mkdir by writing settings directly then forcing path
    const cfgPath = settings.SETTINGS_PATH;
    const prev = settings.load();
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ ...prev, outputDir: roDir }, null, 2)
    );

    const t = stateStore.createThread('answers');
    const req = await orchestrator.submit({
      threadId: t.id,
      mode: 'answers',
      input: 'keep',
    });
    assert.equal(req.status, 'RECEIVED · SAVE FAILED');
    assert.equal(req.content, 'Keep me');

    fs.chmodSync(roDir, 0o755);
    settings.update({ outputDir: outDir });
    const again = await orchestrator.saveAgain(req.id);
    assert.equal(again.status, 'SAVED · VERIFIED');
    assert.equal(fs.readFileSync(again.savedPaths[0].path, 'utf8'), 'Keep me');
    fs.rmSync(roDir, { recursive: true, force: true });
  });
});
