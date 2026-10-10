'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const { log, setLogs } = require('./logger');
const stateStore = require('./stateStore');
const settings = require('./settings');
const { createRouter } = require('./routes');
const orchestrator = require('./orchestrator');
const presence = require('./presence');

const APP_ID = 'you-research-console';

const PORT = Number(process.env.PORT) || 3847;

function seedDemoIfEmpty() {
  const raw = stateStore.getRawState();
  if (raw.threads && raw.threads.length > 0) return;

  // Ensure a default output dir
  const demoOut = path.join(ROOT, 'data', 'output');
  if (!fs.existsSync(demoOut)) fs.mkdirSync(demoOut, { recursive: true });
  const s = settings.load();
  if (!s.outputDir) {
    settings.update({ outputDir: demoOut });
  }
  // Installed launches start clean; the sample report is for development screenshots.
  if (process.env.YDC_DEMO === '0') return;

  const sampleMd = `# RISC-V vs ARM: Key Architectural Differences

RISC-V and ARM are both reduced instruction set architectures, but they differ in licensing, extensibility, and ecosystem maturity [[1]](https://example.com/risc-v-vs-arm).

## Licensing

ARM requires per-chip licensing fees, while RISC-V is open-source and royalty-free.

| Aspect | ARM | RISC-V |
| --- | --- | --- |
| License | Proprietary | Open ISA |
| Extensions | Vendor-controlled | Custom allowed |
| Ecosystem | Mature | Growing |

## Example

\`\`\`c
// Simple RISC-V assembly stub
li a0, 1
ret
\`\`\`

See also the [RISC-V specification](https://riscv.org/).
`;

  const thread = stateStore.createThread('frontier');
  stateStore.updateThread(thread.id, {
    title: 'RISC-V vs ARM comparison',
    draft: '',
  });

  const when = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const fname = `${pad(when.getMonth() + 1)}-${pad(when.getDate())}:${pad(when.getHours())}${pad(when.getMinutes())}.${pad(when.getSeconds())}.md`;
  const fpath = path.join(demoOut, fname);
  fs.writeFileSync(fpath, sampleMd, 'utf8');

  const req = stateStore.createRequest(thread.id, {
    mode: 'frontier',
    input: 'Compare RISC-V and ARM architectures focusing on licensing and extensibility',
    status: 'SAVED · VERIFIED',
  });
  stateStore.updateRequest(req.id, {
    status: 'SAVED · VERIFIED',
    jobId: 'demo-task-seed-001-riscv-vs-arm-comparison-9f3a2b1c8d7e',
    submittedAt: new Date(Date.now() - 120000).toISOString(),
    content: sampleMd,
    savedPaths: [{ path: fpath }],
    sources: [
      {
        url: 'https://example.com/risc-v-vs-arm',
        title: 'RISC-V vs ARM: A Technical Comparison',
      },
    ],
    trackingActive: false,
  });

  // Second empty draft thread for "empty shell" feel when switching
  const empty = stateStore.createThread('exhaustive');
  stateStore.updateThread(empty.id, { title: 'New research' });
  stateStore.setActive(thread.id);

  log('info', 'demo state seeded', { operation: 'seed', outcome: 'ok' });
}

function main() {
  settings.load();
  stateStore.load();
  seedDemoIfEmpty();
  orchestrator.trackInFlight();

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.get('/api/health', (_req, res) => res.json({ app: APP_ID, pid: process.pid, exitWhenClosed: presence.enabled }));
  app.use(express.static(path.join(ROOT, 'public')));
  app.use('/api', createRouter());

  app.get('*', (_req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'index.html'));
  });

  const server = app.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}`;
    fs.writeFileSync(path.join(ROOT, 'PREVIEW_URL.txt'), url + '\n', 'utf8');
    log('info', `server listening on ${url}`, { operation: 'startup', outcome: 'ok' });
    console.log(`You.com Research Console → ${url}`);
  });

  // A job a provider has accepted keeps running there; tracking state is persisted so the next start picks it up.
  function shutdown() {
    log('info', 'shutting down', { operation: 'shutdown' });
    stateStore.persistNow();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }

  // With the window closed, requests still in flight finish first: the report is saved, then the server exits.
  // The wait ends when the last of them is past its own limit (plus a minute to save), so a call that hangs
  // can't keep the server up.
  let waitTimer = null;
  let waitSince = null;
  function exitWhenDone() {
    clearTimeout(waitTimer);
    if (presence.open > 0) return; // a window came back
    const n = orchestrator.inFlightCount();
    if (n === 0) {
      log('info', 'last window closed — exiting', { operation: 'shutdown' });
      shutdown();
      return;
    }
    if (waitSince === null) {
      waitSince = Date.now();
      log('info', `last window closed — waiting for ${n === 1 ? '1 request' : n + ' requests'} to finish before exiting`, { operation: 'shutdown' });
    } else if (Date.now() >= orchestrator.inFlightDeadline()) {
      const waited = Math.round((Date.now() - waitSince) / 60000);
      log('error', `exiting after waiting ${waited === 1 ? '1 minute' : waited + ' minutes'}: ${n === 1 ? '1 request is' : n + ' requests are'} still unfinished past ${n === 1 ? 'its' : 'their'} time limit`, { operation: 'shutdown' });
      shutdown();
      return;
    }
    waitTimer = setTimeout(exitWhenDone, 5000);
  }
  presence.start(() => {
    waitSince = null;
    exitWhenDone();
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = { main, PORT };
