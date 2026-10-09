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
]);

/** @type {object} */
let state = {
  threads: [],
  activeThreadId: null,
  lruOrder: [],
};

let persistTimer = null;
let onChange = () => {};
// Every change bumps rev, so the browser can drop a snapshot that arrives after a newer one.
const BOOT = Date.now().toString(36);
let rev = 0;

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
    // On restart: a job You.com accepted can't be stopped, so tracking picks it up again
    // (the orchestrator polls it on startup). Older data may still hold TRACKING PAUSED.
    for (const t of state.threads) {
      if (!t.requests) t.requests = [];
      for (const r of t.requests) {
        if (
          r.jobId &&
          ['SUBMITTING', 'SUBMITTED', 'RESEARCHING', 'RECEIVING', 'TRACKING PAUSED'].includes(r.status)
        ) {
          r.status = 'RESEARCHING';
          r.trackingActive = true;
        } else if (['SUBMITTING', 'SUBMITTED', 'RESEARCHING', 'RECEIVING', 'RECEIVED', 'SAVING'].includes(r.status)) {
          // Nothing can pick these up after a restart; leaving them "running" would hold the thread forever.
          const hasReport = !!(r.content || (r.contentsPages && r.contentsPages.length));
          r.status = hasReport ? 'RECEIVED · SAVE FAILED' : 'FAILED';
          r.trackingActive = false;
          r.error = {
            title: hasReport ? 'Save interrupted' : 'Submission interrupted',
            operation: hasReport ? 'save' : 'submit',
            status: null,
            message: hasReport
              ? 'The app stopped while saving the report. Use Save again to write it to disk.'
              : 'The app stopped before the API answered, so the result never arrived.',
            timestamp: new Date().toISOString(),
            jobId: r.jobId || null,
          };
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
    // Re-title auto-titled threads (title still equals the old truncation) with the current rule;
    // hand-renamed threads never match and are left alone. Contents threads were never titled,
    // so a 'New Thread' that has sent something is named from its URLs.
    for (const t of state.threads) {
      const first = t.requests.find((r) => r.input);
      if (first && t.title === legacyTitleFromPrompt(first.input)) t.title = titleFromPrompt(first.input);
      const sent = t.requests.find((r) => titleSource(r));
      if (t.title === 'New Thread' && sent) t.title = titleFromPrompt(titleSource(sent));
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
  rev += 1;
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

function legacyTitleFromPrompt(prompt) {
  const t = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return 'Untitled';
  return t.length > 48 ? t.slice(0, 45) + '…' : t;
}

const wordSet = (s) => new Set(s.split(/\s+/).filter(Boolean));

const LEADING_FILLER = wordSet(`
  a an the this that these those some any my our your me us
  i you we i'm im you're we're i've i'd it its
  am is are was were be been being do does did can could would will should shall may might must have has had need want like
  please kindly hi hello hey thanks
  what what's whats which who whom whose why how how's when where
  research investigate explain describe find tell show give provide write summarize summarise look search help list document check determine figure learn know understand review analyze analyse study explore get make create produce build generate
  deeply thoroughly carefully quickly briefly fully comprehensively really just also currently
  about into up out on for of to in and or so regarding
  whether if everything anything something ok okay outline discuss assess evaluate e.g i.e eg ie
`);

const TRAILING_FILLER = wordSet(`
  a an the of to for in on at by with from about into and or but so that which who as is are was were be can could will would should
  you your my our i we it its this these those than then via vs if e.g i.e eg ie etc
`);

// A trailing period on these does not end a sentence ("vs. MySQL", "e.g. CRDTs").
const ABBREVIATIONS = wordSet('e.g i.e eg ie etc vs cf approx incl mr mrs ms dr st');

const TITLE_MAX_TOKENS = 5;
const TITLE_MAX_CHARS = 60;

function titleKey(token) {
  return token
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

// What a thread is titled from: the query, or for Contents the URLs.
function titleSource(req) {
  return req.input || (req.urls || []).join('\n');
}

/** Strips markdown/markup from one line, leaving plain text. Code-fence lines become ''. */
function stripMarkupLine(line) {
  if (/^\s*(```|~~~)/.test(line)) return '';
  let s = line;
  for (let prev; prev !== s; ) {
    prev = s;
    s = s.replace(/^\s*>+\s?/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^\s*#{1,6}\s+/, '');
  }
  return s
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|[\s(])([*_])([^\s*_][^*_]*?)\2(?=$|[\s.,;:!?)])/g, '$1$3');
}

/** Takes up to TITLE_MAX_TOKENS tokens from `from`, stopping at sentence, line or dash boundaries. */
function collectTitleTokens(toks, from) {
  const out = [];
  for (let i = from; i < toks.length && out.length < TITLE_MAX_TOKENS; i++) {
    const tk = toks[i];
    if (out.length && tk.line !== toks[i - 1].line) break;
    if (out.length && /^[—–-]$/.test(tk.text)) break;
    out.push(tk.text);
    if (/[.!?:;]$/.test(tk.text) && !(tk.text.endsWith('.') && ABBREVIATIONS.has(titleKey(tk.text)))) break;
    if (tk.text.endsWith(',') && out.length >= 3) break;
  }
  return out;
}

function trimTrailingFiller(words) {
  const w = words.slice();
  // A lone filler word is kept rather than emptying the title.
  while (w.length > 1 && TRAILING_FILLER.has(titleKey(w[w.length - 1]))) w.pop();
  return w;
}

function cleanTitleEdges(s) {
  let out = s.replace(/^[“‘"'(\[{«]+/, '');
  for (;;) {
    const m = /[.,;:!?"'”’»)\]}]$/.exec(out);
    if (!m) break;
    const open = { ')': '(', ']': '[', '}': '{' }[m[0]];
    // Keep a closing bracket that matches an opener inside the title, e.g. "Kubernetes (k8s)".
    if (open && out.split(m[0]).length <= out.split(open).length) break;
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Short, readable thread title: starts at the first descriptive word, takes up to 5 words,
 * ends on a whole word, and skips filler such as "please explain how".
 */
function titleFromPrompt(prompt) {
  const raw = String(prompt || '');
  // Code inside a fence names nothing; it is used only when the prompt is all code.
  const prose = [];
  const code = [];
  let fenced = false;
  raw.split(/\r?\n/).forEach((line, li) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    for (const text of stripMarkupLine(line).split(/\s+/)) {
      if (text) (fenced ? code : prose).push({ text, line: li });
    }
  });
  const toks = prose.length ? prose : code;
  if (!toks.length) return 'Untitled';

  let start = toks.findIndex((tk) => {
    const k = titleKey(tk.text);
    return k && !LEADING_FILLER.has(k);
  });
  const allFiller = start < 0;
  if (allFiller) start = 0;
  // A one-word label such as "Goal:" or "Task:" is skipped in favor of the first descriptive word after it.
  while (!allFiller && toks[start].text.endsWith(':')) {
    const next = toks.findIndex((tk, i) => i > start && titleKey(tk.text) && !LEADING_FILLER.has(titleKey(tk.text)));
    if (next < 0) break;
    start = next;
  }

  let words = collectTitleTokens(toks, start);
  let isUrl = false;
  if (!allFiller && /^https?:\/\//i.test(toks[start].text)) {
    try {
      let host = new URL(toks[start].text.replace(/[.,;:!?"'”’)\]}]+$/, '')).hostname;
      const others = (raw.match(/https?:\/\/[^\s)>\]]+/gi) || []).length - 1;
      if (others > 0) host += ` +${others}`;
      words = [host];
      isUrl = true;
    } catch (_) {
      /* not a parseable URL: keep the word rule */
    }
  }

  // Without a descriptive word the title is just the opening words, so trailing filler is kept.
  const finish = (ws) => cleanTitleEdges((allFiller ? ws : trimTrailingFiller(ws)).join(' '));
  let title = finish(words);
  while (title.length > TITLE_MAX_CHARS && words.length > 1) {
    words = words.slice(0, -1);
    title = finish(words);
  }
  if (!title) return 'Untitled';
  if (!isUrl && /^\p{Ll}/u.test(title)) title = title.charAt(0).toUpperCase() + title.slice(1);
  if (title.length > TITLE_MAX_CHARS) title = title.slice(0, TITLE_MAX_CHARS - 1) + '…';
  return title;
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
  // Viewing a thread is not using it: the sidebar order changes only on submit.
  state.activeThreadId = threadId;
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
  if (t.title === 'New Thread' && titleSource(req)) {
    t.title = titleFromPrompt(titleSource(req));
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
  touch();
  return found.request;
}

function getPublicState() {
  const active = state.activeThreadId ? getThread(state.activeThreadId) : null;
  return {
    boot: BOOT,
    rev,
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
