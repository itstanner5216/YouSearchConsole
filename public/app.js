'use strict';

/* ── api: the only code that talks to the server ── */
const api = {
  async json(method, url, body) {
    const opts = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
    return data;
  },
  get: (u) => api.json('GET', u),
  post: (u, b) => api.json('POST', u, b),
  put: (u, b) => api.json('PUT', u, b),
  del: (u) => api.json('DELETE', u),
  patch: (u, b) => api.json('PATCH', u, b),
};

const MODE_NAMES = { frontier: 'Frontier', exhaustive: 'Exhaustive', contents: 'Contents', answers: 'Answers' };
const MODE_PLACEHOLDERS = {
  frontier: 'Search query',
  exhaustive: 'Search query',
  contents: 'Paste URLs, one per line',
  answers: 'Search query',
};
const RUNNING = ['SUBMITTING', 'SUBMITTED', 'RESEARCHING', 'RECEIVING', 'RECEIVED', 'SAVING'];
const NARROW = window.matchMedia('(max-width: 960px)');

/* Per-viewer conveniences only; the app works without storage. */
const store = {
  get(k) { try { return localStorage.getItem('ydc.' + k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem('ydc.' + k, String(v)); } catch (_) {} },
};

/* ── UI state ── */
let state = { activeThreadId: null, threads: [], activeThread: null, logs: [] };
let currentMode = 'frontier';
let readerWide = store.get('readerWide') === '1';
let logFilter = 'all';
let logPinned = true;
let es = null;
let draftTimer = null;
let pendingDraft = null; // { threadId, field, value }
let composerThreadId = undefined;
let composerMode = undefined;
let lastReaderKey = null;
let submitting = false;
let pendingMode = null; // mode chosen locally, not yet confirmed by the server

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];


function latestRequest(thread) {
  if (!thread || !thread.requests || !thread.requests.length) return null;
  return thread.requests[thread.requests.length - 1];
}

function statusClass(status) {
  if (status === 'SAVED · VERIFIED') return 'teal';
  if (status === 'FAILED' || status === 'RECEIVED · SAVE FAILED') return 'maroon';
  if (RUNNING.includes(status)) return 'red';
  return '';
}

function formatLocalTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour12: false });
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setText(el, text) {
  const v = String(text ?? '');
  if (el.textContent !== v) el.textContent = v;
}

/** Brief confirmation on a button, then restore its label. */
function flash(btn, text, ms = 1500) {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = text;
  btn.classList.add('done');
  clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => {
    btn.textContent = btn.dataset.label;
    btn.classList.remove('done');
  }, ms);
}

/* ── state → view ── */
function applyState(next) {
  state = next;
  renderAll();
  maybeNotify();
}

function renderAll() {
  renderThreads();
  renderHeader();
  renderMeta();
  renderReader();
  renderComposer();
  renderLogs();
}

/* Threads: keyed, updated in place so scroll position and focus survive. */
const threadEls = new Map();

function createThreadItem(id) {
  const li = document.createElement('li');
  li.className = 'thread-item';
  li.dataset.id = id;
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  li.innerHTML = `
    <span class="dot" aria-hidden="true"></span>
    <div class="thread-meta">
      <div class="thread-title"></div>
      <div class="thread-sub"><span class="t-mode"></span><span class="t-time"></span></div>
    </div>
    <button type="button" class="thread-drop" aria-label="Remove from list" title="Remove from list (files stay on disk)">×</button>`;
  li.addEventListener('click', (e) => {
    if (e.target.closest('.thread-drop')) return;
    activateThread(id);
  });
  li.addEventListener('keydown', (e) => {
    if (e.target !== li) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activateThread(id);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const sib = e.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling;
      if (sib) sib.focus();
    }
  });
  $('.thread-drop', li).addEventListener('click', async (e) => {
    e.stopPropagation();
    const r = await api.del(`/api/threads/${id}`).catch(() => null);
    if (r) applyState(r.state);
  });
  return li;
}

function renderThreads() {
  const ul = $('#thread-list');
  const seen = new Set();
  let prev = null;
  for (const t of state.threads || []) {
    let li = threadEls.get(t.id);
    if (!li) {
      li = createThreadItem(t.id);
      threadEls.set(t.id, li);
    }
    const selected = t.id === state.activeThreadId;
    li.classList.toggle('selected', selected);
    if (selected) li.setAttribute('aria-current', 'true');
    else li.removeAttribute('aria-current');
    li.title = t.title;
    $('.dot', li).className = 'dot ' + (t.statusDot || 'gray');
    setText($('.thread-title', li), t.title);
    setText($('.t-mode', li), (t.mode || '').toUpperCase());
    setText($('.t-time', li), t.updatedAt ? formatLocalTime(t.updatedAt) : '');
    seen.add(t.id);
    const expected = prev ? prev.nextSibling : ul.firstChild;
    if (li !== expected) ul.insertBefore(li, expected);
    prev = li;
  }
  for (const [id, li] of threadEls) {
    if (!seen.has(id)) {
      li.remove();
      threadEls.delete(id);
    }
  }
}

function renderHeader() {
  const t = state.activeThread;
  const req = latestRequest(t);
  const titleEl = $('#active-title');
  if (document.activeElement !== titleEl) setText(titleEl, t ? t.title : 'No thread');
  const mode = t ? t.mode : currentMode;
  const modeEl = $('#header-mode');
  setText(modeEl, (mode || '').toUpperCase());
  modeEl.classList.toggle('contents', mode === 'contents');
  const status = req ? req.status : 'DRAFT';
  const stEl = $('#header-status');
  setText(stEl, status);
  stEl.className = 'status-word ' + statusClass(status);
}

function renderMeta() {
  const req = latestRequest(state.activeThread);
  const meta = $('#meta');
  meta.classList.toggle('hidden', !req?.error);
  if (!req) {
    $('#btn-stop').classList.add('hidden');
    $('#btn-resume').classList.add('hidden');
    return;
  }

  const running = RUNNING.includes(req.status);
  $('#btn-stop').classList.toggle('hidden', !(running && req.jobId && req.trackingActive));
  $('#btn-resume').classList.toggle('hidden', !(req.status === 'TRACKING PAUSED' && req.jobId));

  // Error: what happened, what was attempted, and the one action that helps.
  const errBox = $('#meta-error');
  errBox.classList.toggle('hidden', !req.error);
  if (req.error) {
    const e = req.error;
    setText($('#err-title'), e.title || 'Error');
    setText($('#err-msg'), e.message || '');
    const bits = [e.operation, e.status != null ? `status ${e.status}` : '', formatLocalTime(e.timestamp)].filter(Boolean);
    setText($('#err-detail'), bits.join(' · '));
    const authish = e.status === 401 || e.status === 403 || /auth|key/i.test(e.title || '');
    const saveish = req.status === 'RECEIVED · SAVE FAILED';
    const btn = $('#btn-err-settings');
    btn.classList.toggle('hidden', !(authish || saveish));
    setText(btn, saveish ? 'Change output folder' : 'Edit API key');
  }
}

function getActiveContent() {
  const req = latestRequest(state.activeThread);
  if (!req) return { markdown: '', pages: null, req: null };
  return { markdown: req.content || '', pages: req.contentsPages, req };
}

function contentText() {
  const { markdown, pages, req } = getActiveContent();
  if (req?.mode === 'contents' && pages && pages.length) {
    return pages.map((p) => p.markdown || '').join('\n\n---\n\n');
  }
  return markdown;
}

function renderReader() {
  const { markdown, pages, req } = getActiveContent();
  const body = $('#reader-body');
  const hasContent = !!(req && (markdown || (pages && pages.length)));
  const paths = (req?.savedPaths || []).filter((p) => p.path);

  $('#btn-save-again').classList.toggle('hidden', !(req && req.status === 'RECEIVED · SAVE FAILED'));
  $('#btn-copy').disabled = !hasContent;
  const wideBtn = $('#btn-width');
  wideBtn.setAttribute('aria-pressed', readerWide ? 'true' : 'false');
  setText(wideBtn, readerWide ? 'Reading width' : 'Wide');
  wideBtn.disabled = !hasContent;
  body.classList.toggle('wide-width', readerWide);
  body.classList.toggle('reading-width', !readerWide);
  $('#app').classList.toggle('reader-wide', readerWide);

  // Re-render only when the content itself changed, so scroll and selection survive updates.
  const key = !req
    ? 'none'
    : [req.id, hasContent ? (markdown.length + ':' + (pages ? pages.length : 0) + ':' + paths.length) : req.status].join('|');
  const prog = $('#reader-progress');
  if (prog) setText(prog, progressLine(req));
  if (key === lastReaderKey) return;
  const sameRequest = lastReaderKey && req && lastReaderKey.split('|')[0] === req.id;
  lastReaderKey = key;
  if (!sameRequest) $('#reader').scrollTop = 0;

  if (!req) {
    body.innerHTML = `<div class="empty-reader"><div class="big">Nothing here yet</div><div>Type a search query below and press Enter.</div></div>`;
    return;
  }
  if (!hasContent) {
    let line = 'The report will appear here when it is ready.';
    if (req.status === 'FAILED') line = 'No report. The error is shown above.';
    else if (req.status === 'TRACKING PAUSED') line = 'Tracking is paused. Resume tracking to fetch the report.';
    else if (req.status === 'DRAFT') line = 'Type a search query below and press Enter.';
    const big = RUNNING.includes(req.status) ? 'Working…' : 'No report yet';
    const progress = RUNNING.includes(req.status) ? `<div id="reader-progress" class="reader-progress">${escapeHtml(progressLine(req))}</div>` : '';
    body.innerHTML = `<div class="empty-reader"><div class="big">${big}</div><div>${escapeHtml(line)}</div>${progress}</div>`;
    return;
  }

  if (pages && pages.length && req.mode === 'contents') {
    body.innerHTML = pages
      .map((p, i) => {
        const path = req.savedPaths && req.savedPaths[i] ? req.savedPaths[i].path : '';
        return `<div class="contents-page">
          <div class="contents-page-header">${escapeHtml(p.url || p.title || 'Page ' + (i + 1))}${path ? `<span class="saved">saved to ${escapeHtml(path)}</span>` : ''}</div>
          ${renderMarkdown(p.markdown || '')}
        </div>`;
      })
      .join('');
  } else {
    body.innerHTML = renderMarkdown(markdown);
  }
  dropBrokenImages(body);
}

// A dead image link would leave a broken-image icon in the report; remove it instead.
function dropBrokenImages(root) {
  for (const img of root.querySelectorAll('img')) {
    if (!img.getAttribute('src')) { img.remove(); continue; }
    const drop = () => (img.closest('p') && !img.closest('p').textContent.trim() ? img.closest('p') : img).remove();
    if (img.complete && img.naturalWidth === 0) drop();
    else img.addEventListener('error', drop, { once: true });
  }
}

function progressLine(req) {
  if (!req || !RUNNING.includes(req.status)) return '';
  const sched = req.schedule || {};
  const ok = (v) => v && v !== '—';
  return [ok(sched.elapsedLabel) && `${sched.elapsedLabel} elapsed`, req.trackingActive && ok(sched.nextCheckLabel) && `next check ${sched.nextCheckLabel}`]
    .filter(Boolean)
    .join(' · ');
}

function renderMarkdown(md) {
  // Report content comes from external pages and APIs: always sanitize before it reaches the DOM.
  if (typeof marked !== 'undefined' && marked.parse && typeof DOMPurify !== 'undefined') {
    return DOMPurify.sanitize(marked.parse(md, { async: false }));
  }
  return `<pre>${escapeHtml(md)}</pre>`;
}

/* Composer */
function draftField(mode) {
  return mode === 'contents' ? 'urlsDraft' : 'draft';
}

function fitPrompt() {
  const el = $('#prompt');
  if (document.activeElement !== el) {
    el.style.height = '';
    el.style.overflowY = '';
    el.scrollTop = 0;
    return;
  }
  el.style.height = 'auto';
  const max = Math.round(window.innerHeight * 0.4);
  const h = Math.min(el.scrollHeight, max);
  el.style.height = Math.max(h, 32) + 'px';
  el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
}

function renderComposer() {
  const t = state.activeThread;
  if (pendingMode) currentMode = pendingMode;
  else if (t && t.mode) currentMode = t.mode;

  $$('.mode').forEach((m) => m.setAttribute('aria-checked', m.dataset.mode === currentMode ? 'true' : 'false'));
  const prompt = $('#prompt');
  prompt.placeholder = MODE_PLACEHOLDERS[currentMode] || '';
  $('#prompt').setAttribute('aria-label', currentMode === 'contents' ? 'URLs, one per line' : 'Search query');
  updateHelper();

  // Load the draft only when the thread or mode changes; never overwrite what is being typed.
  const tid = t ? t.id : null;
  if (tid !== composerThreadId || currentMode !== composerMode) {
    composerThreadId = tid;
    composerMode = currentMode;
    prompt.value = t ? t[draftField(currentMode)] || '' : '';
    setComposerError('');
    fitPrompt();
  }
  setText($('#mode-btn-text'), MODE_NAMES[currentMode] || currentMode);
  const btn = $('#btn-submit');
  btn.disabled = submitting;
  btn.classList.toggle('busy', submitting);
  btn.setAttribute('aria-label', submitting ? 'Submitting…' : 'Submit');
}

// The mode descriptions live in the mode menu; the line under the query only carries the Answers length count.
function updateHelper() {
  const n = $('#prompt').value.length;
  setText($('#composer-helper'), currentMode === 'answers' && n ? `${n}/400 characters` : '');
}

function setModeMenu(open) {
  $('#mode-menu').hidden = !open;
  $('#mode-btn').setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) ($('.mode[aria-checked="true"]') || $('.mode')).focus();
}

function setComposerError(msg) {
  setText($('#composer-error'), msg);
}

/* Log */
function renderLogs() {
  const all = state.logs || [];
  setText($('#log-count'), all.length === 1 ? '1 entry' : all.length + ' entries');
  if ($('#log-body').hidden) return;
  const rows = $('#log-rows');
  const keepTop = rows.scrollTop;
  const logs = all.filter((l) => logFilter === 'all' || l.severity === logFilter);
  rows.innerHTML = logs
    .slice(-150)
    .map((l) => {
      const t = l.ts ? new Date(l.ts).toLocaleTimeString(undefined, { hour12: false }) : '';
      const glyph = { info: '·', api: '▸', state: '◆', success: '✓', error: '✕' }[l.severity] || '·';
      const tid = (l.threadId || '').slice(0, 8);
      return `<div class="log-row">
        <span>${escapeHtml(t)}</span>
        <span class="sev-${escapeHtml(l.severity)}">${glyph}</span>
        <span class="thread-tag">${escapeHtml(tid)}</span>
        <span class="msg sev-${escapeHtml(l.severity)}">${escapeHtml(l.message)}</span>
      </div>`;
    })
    .join('');
  rows.scrollTop = logPinned ? rows.scrollHeight : keepTop;
}

/* ── actions ── */
async function activateThread(id) {
  await flushDraft();
  if (NARROW.matches) setNarrowSidebar(false);
  if (id === state.activeThreadId) return;
  const r = await api.post(`/api/threads/${id}/activate`).catch(() => null);
  if (r) applyState(r.state);
}

function scheduleDraftSave() {
  if (!state.activeThreadId) return;
  pendingDraft = { threadId: state.activeThreadId, field: draftField(currentMode), value: $('#prompt').value };
  if (state.activeThread) state.activeThread[pendingDraft.field] = pendingDraft.value;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 400);
}

async function flushDraft() {
  clearTimeout(draftTimer);
  const d = pendingDraft;
  pendingDraft = null;
  if (!d) return;
  await api.patch(`/api/threads/${d.threadId}`, { [d.field]: d.value }).catch(() => {});
}

async function setMode(mode) {
  if (mode === currentMode) return;
  await flushDraft();
  currentMode = mode;
  pendingMode = mode;
  if (state.activeThread) state.activeThread.mode = mode;
  renderComposer();
  renderHeader();
  if (state.activeThreadId) {
    const r = await api.patch(`/api/threads/${state.activeThreadId}`, { mode }).catch(() => null);
    if (pendingMode === mode) pendingMode = null;
    if (r) applyState(r.state);
  } else {
    pendingMode = null;
  }
}

async function submit() {
  if (submitting) return;
  const raw = $('#prompt').value;
  const mode = currentMode;
  const urls = mode === 'contents' ? raw.split(/\s+/).map((s) => s.trim()).filter(Boolean) : [];
  if (mode === 'contents' && !urls.length) return setComposerError('Paste at least one URL.');
  if (mode !== 'contents' && !raw.trim()) return setComposerError('Type a search query first.');
  if (mode === 'answers' && raw.length > 400) return setComposerError(`Answers queries are limited to 400 characters (${raw.length} now).`);
  setComposerError('');

  submitting = true;
  renderComposer();
  try {
    clearTimeout(draftTimer);
    pendingDraft = null;
    if (!state.activeThreadId) {
      const created = await api.post('/api/threads', { mode });
      applyState(created.state);
    }
    const threadId = state.activeThreadId;
    const r = await api.post('/api/submit', { threadId, mode, input: mode === 'contents' ? '' : raw, urls });
    if (mode !== 'contents') {
      $('#prompt').value = '';
      if (state.activeThread) state.activeThread.draft = '';
      await api.patch(`/api/threads/${threadId}`, { draft: '' }).catch(() => {});
    }
    submitting = false;
    applyState(r.state);
    fitPrompt();
    updateHelper();
  } catch (err) {
    submitting = false;
    renderComposer();
    setComposerError(err.message || 'Submit failed.');
    refreshState().catch(() => {});
  }
}

function maybeNotify() {
  const req = latestRequest(state.activeThread);
  if (!req || !req.notifyPending) return;
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const title = state.activeThread?.title || 'Research Console';
    new Notification(title, { body: `${(req.mode || '').toUpperCase()} · ${req.status}` });
  }
  api.post(`/api/notify-ack/${req.id}`).catch(() => {});
}

function connectSSE() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') applyState(msg.state);
      if (msg.type === 'log') {
        state.logs = [...(state.logs || []), msg.entry].slice(-200);
        renderLogs();
      }
    } catch (_) {}
  };
}

async function refreshState() {
  applyState(await api.get('/api/state'));
}

// The reader reserves scrollbar space on both edges; pad the composer by the same amount so their edges match.
function syncGutter() {
  const r = $('#reader');
  document.documentElement.style.setProperty('--gutter', (r.offsetWidth - r.clientWidth) / 2 + 'px');
}

/* ── panels: sidebar and log drawer ── */
function setSidebarCollapsed(collapsed) {
  $('#app').classList.toggle('sidebar-collapsed', collapsed);
  store.set('sidebarCollapsed', collapsed ? '1' : '0');
  syncSidebarToggle();
}

function setNarrowSidebar(open) {
  $('#app').classList.toggle('sidebar-open-narrow', open);
  $('#scrim').hidden = !open;
  syncSidebarToggle();
  if (open) $('#thread-list .selected, #btn-new-thread')?.focus();
}

function sidebarVisible() {
  const app = $('#app');
  return NARROW.matches ? app.classList.contains('sidebar-open-narrow') : !app.classList.contains('sidebar-collapsed');
}

function syncSidebarToggle() {
  const btn = $('#btn-sidebar-toggle');
  const open = sidebarVisible();
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  setText($('#sidebar-toggle-text'), open ? 'Hide threads' : 'Show threads');
  btn.title = open ? 'Hide the thread list' : 'Show the thread list';
}

function setSidebarWidth(px) {
  const w = Math.max(200, Math.min(480, Math.round(px)));
  document.documentElement.style.setProperty('--sidebar-w', w + 'px');
  store.set('sidebarW', w);
}

function setLogOpen(open) {
  $('#log-body').hidden = !open;
  $('#log-resizer').hidden = !open;
  $('#btn-log-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  setText($('#log-action'), open ? 'Hide log' : 'Show log');
  store.set('logOpen', open ? '1' : '0');
  if (open) {
    logPinned = true;
    renderLogs();
  }
}

function setLogHeight(px) {
  const h = Math.max(80, Math.min(Math.round(window.innerHeight * 0.7), Math.round(px)));
  document.documentElement.style.setProperty('--log-h', h + 'px');
  store.set('logH', h);
}

function dragResize(handle, axis, onMove) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('active');
    $('#app').classList.add(axis === 'x' ? 'resizing' : 'resizing-y');
    const move = (ev) => onMove(ev);
    const up = () => {
      handle.classList.remove('active');
      $('#app').classList.remove('resizing', 'resizing-y');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

function restorePanels() {
  const w = Number(store.get('sidebarW'));
  if (w) setSidebarWidth(w);
  const h = Number(store.get('logH'));
  if (h) setLogHeight(h);
  $('#app').classList.toggle('sidebar-collapsed', store.get('sidebarCollapsed') === '1');
  setLogOpen(store.get('logOpen') === '1');
  syncSidebarToggle();
}

/* ── settings ── */
async function openSettings(focusId) {
  if (NARROW.matches) setNarrowSidebar(false);
  $$('.setting-msg').forEach((m) => { m.textContent = ''; m.classList.remove('err'); });
  await refreshSettingsUI().catch(() => {});
  $('#settings-dialog').showModal();
  if (focusId) document.getElementById(focusId)?.focus();
}

function settingMsg(id, text, isErr) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.classList.toggle('err', !!isErr);
}

async function refreshSettingsUI() {
  const data = await api.get('/api/settings');
  const keyStatus = $('#key-status');
  keyStatus.textContent = data.key?.status || 'NO KEY';
  keyStatus.className = 'setting-status ' + (data.key?.present ? 'teal' : 'maroon');
  $('#btn-key-delete').closest('.field-row').hidden = !data.key?.present;

  const check = data.outputCheck || {};
  const dirStatus = $('#dir-status');
  dirStatus.textContent = check.status || '—';
  dirStatus.className = 'setting-status ' + (check.ok ? 'teal' : 'maroon');
  if (document.activeElement !== $('#dir-input')) $('#dir-input').value = data.settings?.outputDir || '';

  const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  $('#notif-perm').textContent = perm.toUpperCase();
  $('#notif-perm').className = 'setting-status ' + (perm === 'granted' ? 'teal' : perm === 'denied' ? 'maroon' : '');
  $('#btn-notif-request').disabled = perm !== 'default';
  $('#btn-notif-request').title =
    perm === 'denied' ? 'Blocked in the browser. Allow notifications in the site settings.' : perm === 'granted' ? 'Already allowed' : '';
  $('#btn-notif-test').disabled = perm !== 'granted';
}

/* ── wiring ── */
function bindUI() {
  $('#btn-new-thread').addEventListener('click', async () => {
    await flushDraft();
    const r = await api.post('/api/threads', { mode: currentMode }).catch(() => null);
    if (r) applyState(r.state);
    if (NARROW.matches) setNarrowSidebar(false);
    $('#prompt').focus();
  });

  $('#btn-sidebar-toggle').addEventListener('click', () => {
    if (NARROW.matches) setNarrowSidebar(!sidebarVisible());
    else setSidebarCollapsed(sidebarVisible());
  });
  $('#scrim').addEventListener('click', () => setNarrowSidebar(false));
  NARROW.addEventListener('change', () => {
    setNarrowSidebar(false);
    syncSidebarToggle();
  });

  dragResize($('#sidebar-resizer'), 'x', (e) => setSidebarWidth(e.clientX));
  $('#sidebar-resizer').addEventListener('keydown', (e) => {
    const cur = $('#sidebar').getBoundingClientRect().width;
    if (e.key === 'ArrowLeft') setSidebarWidth(cur - 16);
    if (e.key === 'ArrowRight') setSidebarWidth(cur + 16);
  });
  dragResize($('#log-resizer'), 'y', (e) => {
    const toggleH = $('#btn-log-toggle').offsetHeight;
    setLogHeight(window.innerHeight - e.clientY - toggleH);
  });
  $('#log-resizer').addEventListener('keydown', (e) => {
    const cur = $('#log-body').getBoundingClientRect().height;
    if (e.key === 'ArrowUp') setLogHeight(cur + 16);
    if (e.key === 'ArrowDown') setLogHeight(cur - 16);
  });

  const titleEl = $('#active-title');
  titleEl.addEventListener('blur', async () => {
    if (!state.activeThreadId) return;
    const title = titleEl.textContent.trim() || 'Untitled';
    if (title === state.activeThread?.title) return;
    const r = await api.patch(`/api/threads/${state.activeThreadId}`, { title }).catch(() => null);
    if (r) applyState(r.state);
  });
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      titleEl.blur();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      titleEl.textContent = state.activeThread?.title || '';
      titleEl.blur();
    }
  });
  titleEl.addEventListener('paste', (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\s+/g, ' '));
  });

  $('#mode-btn').addEventListener('click', () => setModeMenu($('#mode-menu').hidden));
  $('#mode-btn').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setModeMenu(true); }
  });
  $$('.mode').forEach((m) => {
    m.addEventListener('click', () => {
      setMode(m.dataset.mode);
      setModeMenu(false);
      $('#prompt').focus();
    });
    m.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setModeMenu(false);
        $('#mode-btn').focus();
        return;
      }
      if (e.key === 'Tab') { setModeMenu(false); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const modes = $$('.mode');
      const i = modes.indexOf(m) + (e.key === 'ArrowDown' ? 1 : -1);
      modes[(i + modes.length) % modes.length].focus();
    });
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('#mode-menu').hidden && !e.target.closest('.mode-picker')) setModeMenu(false);
  });

  const prompt = $('#prompt');
  prompt.addEventListener('input', () => {
    setComposerError('');
    scheduleDraftSave();
    fitPrompt();
    updateHelper();
  });
  prompt.addEventListener('focus', fitPrompt);
  prompt.addEventListener('blur', () => {
    fitPrompt();
    flushDraft();
  });
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  $('#btn-submit').addEventListener('click', submit);
  window.addEventListener('resize', () => { fitPrompt(); syncGutter(); });

  $('#btn-stop').addEventListener('click', async () => {
    const req = latestRequest(state.activeThread);
    if (!req) return;
    const r = await api.post(`/api/tracking/${req.id}/stop`).catch(() => null);
    if (r) applyState(r.state);
  });
  $('#btn-resume').addEventListener('click', async () => {
    const req = latestRequest(state.activeThread);
    if (!req) return;
    const r = await api.post(`/api/tracking/${req.id}/resume`).catch(() => null);
    if (r) applyState(r.state);
  });
  $('#btn-err-settings').addEventListener('click', () => {
    const req = latestRequest(state.activeThread);
    openSettings(req?.status === 'RECEIVED · SAVE FAILED' ? 'dir-input' : 'key-input');
  });

  $('#btn-copy').addEventListener('click', async () => {
    const ok = await navigator.clipboard.writeText(contentText() || '').then(() => true, () => false);
    flash($('#btn-copy'), ok ? 'Copied' : 'Copy failed');
  });
  const openPath = async (btn, p) => {
    if (!p) return;
    const ok = await api.post('/api/open-path', { path: p }).then(() => true, () => false);
    flash(btn, ok ? 'Opened' : "Couldn't open", ok ? 1200 : 2500);
  };
  $('#btn-open-folder').addEventListener('click', async () => {
    const req = latestRequest(state.activeThread);
    let p = req?.savedPaths?.[0]?.path;
    if (p) p = p.replace(/\/[^/]+$/, '') || p;
    else p = (await api.get('/api/settings').catch(() => ({}))).settings?.outputDir;
    openPath($('#btn-open-folder'), p);
  });
  $('#btn-save-again').addEventListener('click', async () => {
    const req = latestRequest(state.activeThread);
    if (!req) return;
    const btn = $('#btn-save-again');
    btn.disabled = true;
    const r = await api.post(`/api/save-again/${req.id}`).catch((err) => ({ err }));
    btn.disabled = false;
    if (r.state) applyState(r.state);
    else flash(btn, 'Save failed', 2500);
  });
  $('#btn-width').addEventListener('click', () => {
    readerWide = !readerWide;
    store.set('readerWide', readerWide ? '1' : '0');
    renderReader();
  });

  $('#btn-log-toggle').addEventListener('click', () => setLogOpen($('#log-body').hidden));
  $$('.log-filter').forEach((b) =>
    b.addEventListener('click', () => {
      logFilter = b.dataset.sev;
      $$('.log-filter').forEach((x) => x.classList.toggle('active', x === b));
      logPinned = true;
      renderLogs();
    })
  );
  $('#log-rows').addEventListener('scroll', () => {
    const el = $('#log-rows');
    logPinned = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  });

  // Settings
  const dlg = $('#settings-dialog');
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#btn-settings-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close(); // click on the backdrop
  });
  $('#btn-key-save').addEventListener('click', async () => {
    const key = $('#key-input').value.trim();
    if (!key) return settingMsg('key-msg', 'Paste a key first.', true);
    try {
      await api.post('/api/key', { key });
      $('#key-input').value = '';
      settingMsg('key-msg', '');
      await refreshSettingsUI();
    } catch (err) {
      settingMsg('key-msg', err.message, true);
    }
  });
  $('#key-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-key-save').click();
  });
  $('#btn-key-delete').addEventListener('click', async () => {
    const confirmDlg = $('#confirm-dialog');
    confirmDlg.returnValue = '';
    confirmDlg.showModal();
    const result = await new Promise((resolve) =>
      confirmDlg.addEventListener('close', () => resolve(confirmDlg.returnValue), { once: true })
    );
    if (result === 'confirm') {
      await api.del('/api/key').catch((err) => settingMsg('key-msg', err.message, true));
      await refreshSettingsUI();
    }
  });
  $('#btn-dir-save').addEventListener('click', async () => {
    try {
      const r = await api.put('/api/settings', { outputDir: $('#dir-input').value.trim() });
      const check = r.outputCheck || {};
      settingMsg('dir-msg', check.ok === false ? check.message || check.status || 'Folder is not writable.' : '', check.ok === false);
      $('#dir-input').blur();
      await refreshSettingsUI();
    } catch (err) {
      settingMsg('dir-msg', err.message, true);
    }
  });
  $('#dir-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-dir-save').click();
  });
  $('#btn-dir-open').addEventListener('click', async () => {
    const p = $('#dir-input').value.trim();
    if (!p) return;
    const ok = await api.post('/api/open-path', { path: p }).then(() => true, () => false);
    flash($('#btn-dir-open'), ok ? 'Opened' : "Couldn't open", ok ? 1200 : 2500);
  });
  $('#btn-notif-request').addEventListener('click', async () => {
    if (typeof Notification !== 'undefined') await Notification.requestPermission();
    await refreshSettingsUI();
  });
  $('#btn-notif-test').addEventListener('click', () => {
    new Notification('You.com Research Console', { body: 'Test notification' });
    flash($('#btn-notif-test'), 'Sent');
  });

  // Escape closes the topmost transient thing. Dialogs handle their own Escape.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if ($('dialog[open]')) return;
    if (NARROW.matches && sidebarVisible()) {
      setNarrowSidebar(false);
      $('#btn-sidebar-toggle').focus();
    } else if (!$('#log-body').hidden) {
      setLogOpen(false);
    } else if (document.activeElement === $('#prompt')) {
      $('#prompt').blur();
    }
  });

  // Backup poll in case SSE drops; rendering is in place, so this never disturbs the view.
  setInterval(() => {
    refreshState().catch(() => {});
  }, 2000);
}

async function init() {
  restorePanels();
  syncGutter();
  bindUI();
  await refreshState();
  if (!state.activeThreadId) {
    const r = await api.post('/api/threads', { mode: 'frontier' });
    applyState(r.state);
  }
  connectSSE();
}

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="color:#E35D5D;padding:16px">Failed to start UI: ${escapeHtml(err.message)}</pre>`
  );
});
