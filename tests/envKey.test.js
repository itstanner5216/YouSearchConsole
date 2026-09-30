'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('envKey', () => {
  let tmp;
  let envKey;
  let logger;
  let prevEnvPath;
  let prevKey;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ydc-key-'));
    prevEnvPath = process.env.YDC_ENV_PATH;
    prevKey = process.env.YDC_API_KEY;
    delete process.env.YDC_API_KEY;

    const envFile = path.join(tmp, '.env');
    fs.writeFileSync(envFile, '', 'utf8');
    process.env.YDC_ENV_PATH = envFile;

    envKey = require('../server/envKey');
    envKey.rebindPaths({ envPath: envFile });
    logger = require('../server/logger');
  });

  afterEach(() => {
    try {
      if (envKey) envKey.rebindPaths({});
    } catch (_) {}
    if (prevEnvPath === undefined) delete process.env.YDC_ENV_PATH;
    else process.env.YDC_ENV_PATH = prevEnvPath;
    if (prevKey === undefined) delete process.env.YDC_API_KEY;
    else process.env.YDC_API_KEY = prevKey;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('saves, reports presence, replaces, and deletes key', () => {
    envKey.deleteKey();
    assert.equal(envKey.presence().present, false);
    assert.equal(envKey.presence().status, 'NO KEY');

    envKey.setKey('test-key-abc123xyz');
    assert.equal(envKey.presence().present, true);
    assert.equal(envKey.presence().status, 'KEY SAVED');
    assert.equal(envKey.getKey(), 'test-key-abc123xyz');
    // Confirm writes went to the temp .env, not the project one
    assert.ok(envKey.ENV_PATH.startsWith(tmp));

    envKey.setKey('test-key-replaced-999');
    assert.equal(envKey.getKey(), 'test-key-replaced-999');

    envKey.deleteKey();
    assert.equal(envKey.presence().present, false);
    assert.equal(envKey.getKey(), '');
  });

  it('redacts secrets from strings and objects', () => {
    const s = logger.redact('X-API-Key: test-key-abc123xyz and Bearer tok_secret_value');
    assert.ok(!s.includes('test-key-abc123xyz'));
    assert.ok(!s.includes('tok_secret_value'));
    assert.ok(s.includes('***'));

    const obj = logger.redact({ apiKey: 'secret12345678', nested: { token: 'abc' }, ok: 'fine' });
    assert.equal(obj.apiKey, '***');
    assert.equal(obj.nested.token, '***');
    assert.equal(obj.ok, 'fine');
  });
});
