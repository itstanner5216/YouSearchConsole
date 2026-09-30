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
      orchestrator.pauseTracking(id, 'test_cleanup');
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

  it('stop and resume tracking against existing job ID', async () => {
    let polls = 0;
    youClient.setFetch(
      mockFetchSequence([
        {
          status: 200,
          body: {
            task_id: 'task-resume-1',
            type: 'research',
            status: 'queued',
            stream_url: '',
            created_at: new Date().toISOString(),
          },
        },
        () => {
          polls += 1;
          return {
            ok: true,
            status: 200,
            statusText: '200',
            headers: { get: () => null },
            async json() {
              return { task_id: 'task-resume-1', status: 'running' };
            },
            async text() {
              return '{}';
            },
          };
        },
      ])
    );

    const thread = stateStore.createThread('frontier');
    const req = await orchestrator.submit({
      threadId: thread.id,
      mode: 'frontier',
      input: 'test question',
    });
    assert.equal(req.jobId, 'task-resume-1');
    assert.ok(['SUBMITTED', 'RESEARCHING'].includes(req.status));

    const paused = orchestrator.pauseTracking(req.id, 'user_stop');
    assert.equal(paused.status, 'TRACKING PAUSED');
    assert.equal(paused.trackingActive, false);
    assert.equal(paused.jobId, 'task-resume-1');

    const resumed = orchestrator.resumeTracking(req.id);
    assert.equal(resumed.trackingActive, true);
    assert.equal(resumed.jobId, 'task-resume-1');
    assert.equal(resumed.status, 'RESEARCHING');

    orchestrator.pauseTracking(req.id, 'test_cleanup');
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
