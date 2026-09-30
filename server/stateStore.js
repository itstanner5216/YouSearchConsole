'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { log, getLogs, setLogs } = require('./logger');

const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', 'data');

let DATA_DIR = resolveDataDir();
let STATE_PATH = resolveStatePath();
const MAX_SIDEBAR = 20;

function resolveDataDir() {
  if (process.env.YDC_DATA_DIR) return path.resolve(process.env.YDC_DATA_DIR);
  return DEFAULT_DATA_DIR;
}

function resolveStatePath() {
  if (process.env.YDC_STATE_PATH) return path.resolve(process.env.YDC_STATE_PATH);
  return path.join(DATA_DIR, 'state.json');
}

/**
 * Rebind data/state paths (for tests). Pass a temp dir or rely on env vars.
 * @param {{ dataDir?: string, statePath?: string }} [opts]
 */
function rebindPaths(opts = {}) {
  if (opts.dataDir) {
    DATA_DIR = path.resolve(opts.dataDir);
  } else if (process.env.YDC_DATA_DIR) {
    DATA_DIR = path.resolve(process.env.YDC_DATA_DIR);
  } else {
    DATA_DIR = DEFAULT_DATA_DIR;
  }
  if (opts.statePath) {
    STATE_PATH = path.resolve(opts.statePath);
  } else if (process.env.YDC_STATE_PATH) {
    STATE_PATH = path.resolve(process.env.YDC_STATE_PATH);
  } else {
    STATE_PATH = path.join(DATA_DIR, 'state.json');
  }
  return { DATA_DIR, STATE_PATH };
}

const STATES = Object.freeze([
  'DRAFT',
  'SUBMITTING',
  'SUBMITTED',
  'RESEARCHING',
  'RECEIVING',
  'RECEIVED',
  'SAVING',
  'SAVED · VERIFIED',
  'RECEIVED · SAVE FAILED',
  'FAILED',
  'TRACKING PAUSED',
]);

/** @type {object} */
let state = {
  threads: [],
  activeThreadId: null,
  lruOrder: [],
};

let persistTimer = null;
let onChange = () => {};

function ensureDataDir() {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(STATE_PATH)) {
    state = { threads: [], activeThreadId: null, lruOrder: [] };
    setLogs([]);
    return getPublicState();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    state = {
      threads: Array.isArray(raw.threads) ? raw.threads : [],
      activeThreadId: raw.activeThreadId || null,
      lruOrder: Array.isArray(raw.lruOrder) ? raw.lruOrder : [],
    };
    // On restart: any in-flight research → TRACKING PAUSED, no auto-poll
    for (const t of state.threads) {
      if (!t.requests) t.requests = [];
      for (const r of t.requests) {
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
    setLogs(Array.isArray(raw.logs) ? raw.logs : []);
    // Ensure LRU covers existing threads
    const ids = new Set(state.threads.map((t) => t.id));
    state.lruOrder = state.lruOrder.filter((id) => ids.has(id));
    for (const t of state.threads) {
      if (!state.lruOrder.includes(t.id)) state.lruOrder.push(t.id);
    }
    persistNow();
  } catch (err) {
    log('error', 'state load failed', { operation: 'state.load', details: { error: err.message } });
    state = { threads: [], activeThreadId: null, lruOrder: [] };
  }
  return getPublicState();
}

function persistNow() {
  ensureDataDir();
  const payload = {
    threads: state.threads,
    activeThreadId: state.activeThreadId,
    lruOrder: state.lruOrder,
    logs: getLogs(),
  };
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      persistNow();
    } catch (err) {
      console.error('persist failed', err.message);
    }
  }, 50);
}

/** Cancel any pending debounced write (used by tests before rebinding paths). */
function cancelPendingPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

function touch() {
  schedulePersist();
  try {
    onChange(getPublicState());
  } catch (_) {
    /* ignore */
  }
}

function setOnChange(fn) {
  onChange = typeof fn === 'function' ? fn : () => {};
}

function titleFromPrompt(prompt) {
  const t = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return 'Untitled';
  return t.length > 48 ? t.slice(0, 45) + '…' : t;
}

function createThread(mode = 'frontier') {
  const id = randomUUID();
  const now = new Date().toISOString();
  const thread = {
    id,
    title: 'New Thread',
    mode: normalizeMode(mode),
    draft: '',
    urlsDraft: '',
    createdAt: now,
    updatedAt: now,
    requests: [],
  };
  state.threads.push(thread);
  touchLru(id);
  state.activeThreadId = id;
  // Evict from sidebar list only
  while (state.lruOrder.length > MAX_SIDEBAR) {
    state.lruOrder.pop(); // drop oldest from list; thread object & disk untouched
  }
  log('info', 'thread created', { threadId: id, operation: 'thread.create' });
  touch();
  return thread;
}

function normalizeMode(mode) {
  const m = String(mode || 'frontier').toLowerCase();
  if (['frontier', 'exhaustive', 'contents', 'answers'].includes(m)) return m;
  return 'frontier';
}

function touchLru(threadId) {
  state.lruOrder = state.lruOrder.filter((id) => id !== threadId);
  state.lruOrder.unshift(threadId);
  while (state.lruOrder.length > MAX_SIDEBAR) {
    state.lruOrder.pop();
  }
}

function getThread(id) {
  return state.threads.find((t) => t.id === id) || null;
}

function listSidebarThreads() {
  return state.lruOrder
    .map((id) => getThread(id))
    .filter(Boolean)
    .map(summarizeThread);
}

function summarizeThread(t) {
  const latest = t.requests && t.requests.length ? t.requests[t.requests.length - 1] : null;
  return {
    id: t.id,
    title: t.title,
    mode: t.mode,
    updatedAt: t.updatedAt,
    status: latest ? latest.status : 'DRAFT',
    statusDot: statusDot(latest ? latest.status : 'DRAFT'),
  };
}

function statusDot(status) {
  if (['SAVED · VERIFIED'].includes(status)) return 'teal';
  if (['FAILED', 'RECEIVED · SAVE FAILED'].includes(status)) return 'maroon';
  if (['TRACKING PAUSED'].includes(status)) return 'paused';
  if (
    ['SUBMITTING', 'SUBMITTED', 'RESEARCHING', 'RECEIVING', 'RECEIVED', 'SAVING'].includes(
      status
    )
  ) {
    return 'red';
  }
  return 'gray';
}

function setActive(threadId) {
  const t = getThread(threadId);
  if (!t) throw Object.assign(new Error('Thread not found'), { status: 404 });
  state.activeThreadId = threadId;
  touchLru(threadId);
  t.updatedAt = new Date().toISOString();
  touch();
  return t;
}

function updateThread(threadId, patch) {
  const t = getThread(threadId);
  if (!t) throw Object.assign(new Error('Thread not found'), { status: 404 });
  if (patch.title !== undefined) t.title = String(patch.title).slice(0, 120) || 'Untitled';
  if (patch.mode !== undefined) t.mode = normalizeMode(patch.mode);
  if (patch.draft !== undefined) t.draft = String(patch.draft);
  if (patch.urlsDraft !== undefined) t.urlsDraft = String(patch.urlsDraft);
  t.updatedAt = new Date().toISOString();
  touchLru(threadId);
  touch();
  return t;
}

/**
 * Drop from sidebar list only — does not delete thread data or files.
 */
function dropFromSidebar(threadId) {
  state.lruOrder = state.lruOrder.filter((id) => id !== threadId);
  if (state.activeThreadId === threadId) {
    state.activeThreadId = state.lruOrder[0] || null;
  }
  log('info', 'thread dropped from sidebar', {
    threadId,
    operation: 'thread.drop',
    details: { note: 'disk untouched' },
  });
  touch();
  return { ok: true, activeThreadId: state.activeThreadId };
}

function createRequest(threadId, fields) {
  const t = getThread(threadId);
  if (!t) throw Object.assign(new Error('Thread not found'), { status: 404 });
  const req = {
    id: randomUUID(),
    threadId,
    mode: fields.mode || t.mode,
    input: fields.input || '',
    urls: fields.urls || [],
    status: fields.status || 'DRAFT',
    jobId: null,
    submittedAt: null,
    lastCheckAt: null,
    trackingActive: false,
    pauseReason: null,
    content: null,
    contentsPages: null,
    rawResponse: null,
    sources: null,
    savedPaths: [],
    error: null,
    schedule: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  t.requests.push(req);
  if (t.title === 'New Thread' && req.input) {
    t.title = titleFromPrompt(req.input);
  }
  t.updatedAt = new Date().toISOString();
  touchLru(threadId);
  touch();
  return req;
}

function getRequest(requestId) {
  for (const t of state.threads) {
    const r = (t.requests || []).find((x) => x.id === requestId);
    if (r) return { thread: t, request: r };
  }
  return null;
}

function updateRequest(requestId, patch) {
  const found = getRequest(requestId);
  if (!found) throw Object.assign(new Error('Request not found'), { status: 404 });
  Object.assign(found.request, patch, { updatedAt: new Date().toISOString() });
  found.thread.updatedAt = new Date().toISOString();
  touchLru(found.thread.id);
  touch();
  return found.request;
}

function getPublicState() {
  const active = state.activeThreadId ? getThread(state.activeThreadId) : null;
  return {
    activeThreadId: state.activeThreadId,
    threads: listSidebarThreads(),
    // Full thread objects keyed — frontend needs active thread detail
    activeThread: active || null,
    // Also expose all threads for restore (full data lives in state.json)
    allThreadCount: state.threads.length,
    logs: getLogs().slice(-200),
    states: STATES,
  };
}

/** Full dump for tests / internal */
function getRawState() {
  return state;
}

function setRawState(next, opts = {}) {
  state = next;
  if (opts.persist === false) {
    cancelPendingPersist();
    return;
  }
  touch();
}

module.exports = {
  STATES,
  MAX_SIDEBAR,
  get STATE_PATH() {
    return STATE_PATH;
  },
  get DATA_DIR() {
    return DATA_DIR;
  },
  rebindPaths,
  load,
  persistNow,
  cancelPendingPersist,
  setOnChange,
  createThread,
  getThread,
  listSidebarThreads,
  setActive,
  updateThread,
  dropFromSidebar,
  createRequest,
  getRequest,
  updateRequest,
  getPublicState,
  getRawState,
  setRawState,
  touchLru,
  titleFromPrompt,
  statusDot,
  normalizeMode,
  touch,
};
