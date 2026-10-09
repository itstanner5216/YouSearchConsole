'use strict';

const fs = require('fs');
const path = require('path');
const { redact } = require('./logger');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_ENV_PATH = path.join(ROOT, '.env');
let ENV_PATH = resolveEnvPath();
const KEY_NAME = 'YDC_API_KEY';

function resolveEnvPath() {
  if (process.env.YDC_ENV_PATH) return path.resolve(process.env.YDC_ENV_PATH);
  return DEFAULT_ENV_PATH;
}

/**
 * Rebind .env path (for tests).
 * @param {{ envPath?: string }} [opts]
 */
function rebindPaths(opts = {}) {
  if (opts.envPath) {
    ENV_PATH = path.resolve(opts.envPath);
  } else if (process.env.YDC_ENV_PATH) {
    ENV_PATH = path.resolve(process.env.YDC_ENV_PATH);
  } else {
    ENV_PATH = DEFAULT_ENV_PATH;
  }
  return { ENV_PATH };
}

function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    map[k] = v;
  }
  return map;
}

function writeEnvFile(map) {
  const dir = path.dirname(ENV_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const lines = Object.entries(map).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_PATH, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

// Each provider keeps its key under its own name in the same .env; the default is You.com's.
function getKey(name = KEY_NAME) {
  const map = readEnvFile();
  const fromFile = map[name];
  if (fromFile) return fromFile;
  return process.env[name] || '';
}

function hasKey(name = KEY_NAME) {
  return Boolean(getKey(name));
}

function setKey(value, name = KEY_NAME) {
  if (!value || typeof value !== 'string' || !value.trim()) {
    throw new Error('API key must be a non-empty string');
  }
  // One line in .env: a key with spaces or line breaks in it was pasted wrong.
  if (/\s/.test(value.trim())) throw new Error("API key can't contain spaces or line breaks");
  const map = readEnvFile();
  map[name] = value.trim();
  writeEnvFile(map);
  process.env[name] = value.trim();
  return { present: true };
}

function deleteKey(name = KEY_NAME) {
  const map = readEnvFile();
  delete map[name];
  writeEnvFile(map);
  delete process.env[name];
  return { present: false };
}

function presence(name = KEY_NAME) {
  const present = hasKey(name);
  return { present, status: present ? 'KEY SAVED' : 'NO KEY' };
}

function safeError(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  return redact(msg);
}

module.exports = {
  get ENV_PATH() {
    return ENV_PATH;
  },
  KEY_NAME,
  rebindPaths,
  getKey,
  hasKey,
  setKey,
  deleteKey,
  presence,
  safeError,
  readEnvFile,
  writeEnvFile,
};
