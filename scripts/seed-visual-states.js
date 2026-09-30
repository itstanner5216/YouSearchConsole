'use strict';

/**
 * One-shot helper: add TRACKING PAUSED + RECEIVED · SAVE FAILED demo threads
 * for visual DoD screenshots. Idempotent by title. Keeps RISC-V verified.
 * Does not call the You.com API.
 *
 * Usage (server stopped recommended so it reloads state on start):
 *   node scripts/seed-visual-states.js
 */

const path = require('path');
const stateStore = require('../server/stateStore');
const { log, setLogs, getLogs } = require('../server/logger');

const PAUSED_TITLE = 'Quantum annealing survey (paused)';
const SAVE_FAIL_TITLE = 'Save-failed demo report';
const FAILED_TITLE = 'API failed demo';

const sampleMd = `# Save-failed retained report

This markdown was received from the API but the disk write failed.

## Findings

| Item | Value |
| --- | --- |
| Status | RECEIVED · SAVE FAILED |
| Action | Save Again |

\`\`\`js
console.log('content retained in memory');
\`\`\`

See [docs](https://example.com/save-failed).
`;

function findThreadByTitle(title) {
  return stateStore.getRawState().threads.find((t) => t.title === title) || null;
}

function ensurePaused() {
  let t = findThreadByTitle(PAUSED_TITLE);
  if (t) {
    const latest = t.requests[t.requests.length - 1];
    if (latest && latest.status === 'TRACKING PAUSED' && latest.jobId) return t;
  } else {
    t = stateStore.createThread('frontier');
    stateStore.updateThread(t.id, { title: PAUSED_TITLE, draft: '' });
  }

  // Clear prior demo requests if re-seeding
  t.requests = [];
  const req = stateStore.createRequest(t.id, {
    mode: 'frontier',
    input: 'Survey quantum annealing hardware vendors and compare coherence times',
    status: 'TRACKING PAUSED',
  });
  stateStore.updateRequest(req.id, {
    status: 'TRACKING PAUSED',
    jobId: 'demo-task-seed-paused-quantum-annealing-7c4e91ab02df',
    submittedAt: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
    lastCheckAt: new Date(Date.now() - 45 * 1000).toISOString(),
    trackingActive: false,
    pauseReason: 'user_stop',
    content: null,
    schedule: null,
    error: null,
  });
  return stateStore.getThread(t.id);
}

function ensureSaveFailed() {
  let t = findThreadByTitle(SAVE_FAIL_TITLE);
  if (t) {
    const latest = t.requests[t.requests.length - 1];
    if (latest && latest.status === 'RECEIVED · SAVE FAILED' && latest.content) return t;
  } else {
    t = stateStore.createThread('exhaustive');
    stateStore.updateThread(t.id, { title: SAVE_FAIL_TITLE, draft: '' });
  }

  t.requests = [];
  const req = stateStore.createRequest(t.id, {
    mode: 'exhaustive',
    input: 'Produce a short report that will demonstrate Save Again after a write failure',
    status: 'RECEIVED · SAVE FAILED',
  });
  const jobId = 'demo-task-seed-savefail-report-aa11bb22cc33';
  stateStore.updateRequest(req.id, {
    status: 'RECEIVED · SAVE FAILED',
    jobId,
    submittedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    trackingActive: false,
    content: sampleMd,
    savedPaths: [],
    sources: [{ url: 'https://example.com/save-failed', title: 'Save failure demo' }],
    error: {
      title: 'Save failed',
      operation: 'save',
      status: 'EACCES',
      message: 'EACCES: permission denied, open \'/demo/readonly/output.md\'',
      timestamp: new Date(Date.now() - 60 * 1000).toISOString(),
      jobId,
    },
  });
  return stateStore.getThread(t.id);
}

function ensureFailed() {
  let t = findThreadByTitle(FAILED_TITLE);
  if (t) {
    const latest = t.requests[t.requests.length - 1];
    if (latest && latest.status === 'FAILED') return t;
  } else {
    t = stateStore.createThread('answers');
    stateStore.updateThread(t.id, { title: FAILED_TITLE, draft: '' });
  }

  t.requests = [];
  const req = stateStore.createRequest(t.id, {
    mode: 'answers',
    input: 'What is the capital of Atlantis?',
    status: 'FAILED',
  });
  const jobId = 'demo-task-seed-failed-answers-deadbeef0001';
  stateStore.updateRequest(req.id, {
    status: 'FAILED',
    jobId,
    submittedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    trackingActive: false,
    content: null,
    error: {
      title: 'You.com request failed',
      operation: 'answers',
      status: 402,
      message: 'Payment Required — demo seeded failure (no credentials leaked)',
      timestamp: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      jobId,
    },
  });
  return stateStore.getThread(t.id);
}

function main() {
  stateStore.load();
  const riscv = stateStore
    .getRawState()
    .threads.find((t) => (t.title || '').includes('RISC-V'));
  if (!riscv) {
    console.error('Expected RISC-V verified thread missing — aborting (run app seed first).');
    process.exit(1);
  }

  const paused = ensurePaused();
  const saveFail = ensureSaveFailed();
  const failed = ensureFailed();

  // Leave active on RISC-V verified for parent photography default
  stateStore.setActive(riscv.id);
  stateStore.persistNow();

  log('info', 'visual DoD states seeded', {
    operation: 'seed.visual',
    outcome: 'ok',
    details: {
      paused: paused.id,
      saveFailed: saveFail.id,
      failed: failed.id,
      active: riscv.id,
    },
  });
  stateStore.persistNow();

  const titles = stateStore.getRawState().threads.map((t) => {
    const st = t.requests?.length ? t.requests[t.requests.length - 1].status : 'DRAFT';
    return `${t.title} → ${st}`;
  });
  console.log('Seeded visual states. Threads:');
  titles.forEach((line) => console.log(' -', line));
  console.log('Active:', riscv.title);
}

main();
