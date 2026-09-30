'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', 'data');

let DATA_DIR = resolveDataDir();
let SETTINGS_PATH = resolveSettingsPath();

const DEFAULTS = {
  outputDir: '',
  notificationsEnabled: true,
};

function resolveDataDir() {
  if (process.env.YDC_DATA_DIR) return path.resolve(process.env.YDC_DATA_DIR);
  return DEFAULT_DATA_DIR;
}

function resolveSettingsPath() {
  if (process.env.YDC_SETTINGS_PATH) return path.resolve(process.env.YDC_SETTINGS_PATH);
  return path.join(DATA_DIR, 'settings.json');
}

/**
 * Rebind data/settings paths (for tests). Pass a temp dir or rely on env vars.
 * @param {{ dataDir?: string, settingsPath?: string }} [opts]
 */
function rebindPaths(opts = {}) {
  if (opts.dataDir) {
    DATA_DIR = path.resolve(opts.dataDir);
  } else if (process.env.YDC_DATA_DIR) {
    DATA_DIR = path.resolve(process.env.YDC_DATA_DIR);
  } else {
    DATA_DIR = DEFAULT_DATA_DIR;
  }
  if (opts.settingsPath) {
    SETTINGS_PATH = path.resolve(opts.settingsPath);
  } else if (process.env.YDC_SETTINGS_PATH) {
    SETTINGS_PATH = path.resolve(process.env.YDC_SETTINGS_PATH);
  } else {
    SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
  }
  return { DATA_DIR, SETTINGS_PATH };
}

function ensureDataDir() {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(SETTINGS_PATH)) {
    save(DEFAULTS);
    return { ...DEFAULTS };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(settings) {
  ensureDataDir();
  const next = { ...DEFAULTS, ...settings };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/**
 * Validate output directory: create if missing, check writable.
 * @returns {{ ok: boolean, status: string, path: string, error?: string }}
 */
function validateOutputDir(dirPath) {
  if (!dirPath || typeof dirPath !== 'string' || !dirPath.trim()) {
    return { ok: false, status: 'NO DIRECTORY', path: '', error: 'Output directory is empty' };
  }
  const abs = path.resolve(dirPath.trim());
  try {
    if (!fs.existsSync(abs)) {
      // Avoid mkdir into virtual FS roots that can block (e.g. /proc)
      const root = abs.split(path.sep).filter(Boolean)[0];
      if (root && ['proc', 'sys', 'dev'].includes(root)) {
        return {
          ok: false,
          status: 'INVALID',
          path: abs,
          error: `Refusing to create directory under /${root}`,
        };
      }
      fs.mkdirSync(abs, { recursive: true });
    }
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) {
      return { ok: false, status: 'NOT A DIRECTORY', path: abs, error: 'Path exists but is not a directory' };
    }
    // write check
    const probe = path.join(abs, `.write-check-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return { ok: true, status: 'WRITABLE', path: abs };
  } catch (err) {
    return {
      ok: false,
      status: err.code || 'ERROR',
      path: abs,
      error: err.message || String(err),
    };
  }
}

function update(partial) {
  const current = load();
  const next = { ...current, ...partial };
  if (partial.outputDir !== undefined) {
    const check = validateOutputDir(partial.outputDir);
    next.outputDir = check.path || String(partial.outputDir || '').trim();
    save(next);
    log('info', 'settings:outputDir updated', {
      operation: 'settings',
      outcome: check.ok ? 'writable' : 'failed',
      details: { path: next.outputDir, status: check.status },
    });
    return { settings: next, outputCheck: check };
  }
  save(next);
  log('info', 'settings updated', { operation: 'settings', outcome: 'ok' });
  return { settings: next, outputCheck: validateOutputDir(next.outputDir) };
}

module.exports = {
  get SETTINGS_PATH() {
    return SETTINGS_PATH;
  },
  get DATA_DIR() {
    return DATA_DIR;
  },
  rebindPaths,
  load,
  save,
  update,
  validateOutputDir,
  DEFAULTS,
};
