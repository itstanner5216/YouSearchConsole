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

const PORT = Number(process.env.PORT) || 3847;

function seedDemoIfEmpty() {
  const raw = stateStore.getRawState();
  if (raw.threads && raw.threads.length > 0) return;

  // Ensure a default output dir for demo
  const demoOut = path.join(ROOT, 'data', 'output');
  if (!fs.existsSync(demoOut)) fs.mkdirSync(demoOut, { recursive: true });
  const s = settings.load();
  if (!s.outputDir) {
    settings.update({ outputDir: demoOut });
  }

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

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(express.static(path.join(ROOT, 'public')));
  app.use('/api', createRouter());

  app.get('*', (_req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'index.html'));
  });

  const server = app.listen(PORT, '0.0.0.0', () => {
    const url = `http://127.0.0.1:${PORT}`;
    fs.writeFileSync(path.join(ROOT, 'PREVIEW_URL.txt'), url + '\n', 'utf8');
    log('info', `server listening on ${url}`, { operation: 'startup', outcome: 'ok' });
    console.log(`You.com Research Console → ${url}`);
  });

  function shutdown() {
    log('info', 'shutting down — pausing tracking', { operation: 'shutdown' });
    orchestrator.stopAllTracking();
    stateStore.persistNow();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = { main, PORT };
