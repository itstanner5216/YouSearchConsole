'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function tempDir(prefix = 'ydc-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Point settings + stateStore at an isolated temp data dir for the duration of a test file.
 * Call before mutating settings/state. Returns { dataDir, outputDir, restore }.
 */
function isolateDataDir(prefix = 'ydc-data-') {
  const settings = require('../server/settings');
  const stateStore = require('../server/stateStore');
  const dataDir = tempDir(prefix);
  const outputDir = path.join(dataDir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  const prevEnv = {
    YDC_DATA_DIR: process.env.YDC_DATA_DIR,
    YDC_SETTINGS_PATH: process.env.YDC_SETTINGS_PATH,
    YDC_STATE_PATH: process.env.YDC_STATE_PATH,
  };

  process.env.YDC_DATA_DIR = dataDir;
  delete process.env.YDC_SETTINGS_PATH;
  delete process.env.YDC_STATE_PATH;

  settings.rebindPaths({ dataDir });
  stateStore.rebindPaths({ dataDir });

  // Seed empty settings/state under the temp dir
  settings.save({
    outputDir,
    notificationsEnabled: true,
  });
  stateStore.setRawState({ threads: [], activeThreadId: null, lruOrder: [] });
  stateStore.persistNow();

  function restore() {
    try {
      stateStore.cancelPendingPersist();
      stateStore.persistNow();
      stateStore.cancelPendingPersist();
    } catch (_) {}
    if (prevEnv.YDC_DATA_DIR === undefined) delete process.env.YDC_DATA_DIR;
    else process.env.YDC_DATA_DIR = prevEnv.YDC_DATA_DIR;
    if (prevEnv.YDC_SETTINGS_PATH === undefined) delete process.env.YDC_SETTINGS_PATH;
    else process.env.YDC_SETTINGS_PATH = prevEnv.YDC_SETTINGS_PATH;
    if (prevEnv.YDC_STATE_PATH === undefined) delete process.env.YDC_STATE_PATH;
    else process.env.YDC_STATE_PATH = prevEnv.YDC_STATE_PATH;

    settings.rebindPaths({});
    stateStore.rebindPaths({});
    // Clear in-memory test state without writing to live data/
    stateStore.setRawState({ threads: [], activeThreadId: null, lruOrder: [] }, { persist: false });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { dataDir, outputDir, restore };
}

function mockFetchSequence(responses) {
  let i = 0;
  return async (url, opts) => {
    const step = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (typeof step === 'function') return step(url, opts);
    const { status = 200, body = {}, headers = {} } = step;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: { get: (k) => headers[k.toLowerCase()] },
      async json() {
        return typeof body === 'string' ? JSON.parse(body) : body;
      },
      async text() {
        return typeof body === 'string' ? body : JSON.stringify(body);
      },
    };
  };
}

module.exports = { tempDir, isolateDataDir, mockFetchSequence };
