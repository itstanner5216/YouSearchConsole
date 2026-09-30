'use strict';

const api = {
  async json(method, url, body) {
    const opts = {
      method,
      headers: { Accept: 'application/json' },
    };
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

const MODE_HELPERS = {
  frontier: 'Frontier · background research · paid on Submit',
  exhaustive: 'Exhaustive · background research · paid on Submit',
  contents: 'Contents · paste URLs (one per line) · Markdown extraction',
  answers: 'Answers · query max 400 characters · synthesized answer',
};
const MODE_PLACEHOLDERS = {
  frontier: 'Ask a deep research question…',
  exhaustive: 'Ask a comprehensive research question…',
  contents: 'Optional note (URLs go above)…',
  answers: 'Ask a question (max 400 chars)…',
};

/** @type {object} */
let state = {
  activeThreadId: null,
  threads: [],
  activeThread: null,
  logs: [],
};

let currentMode = 'frontier';
let readerTab = 'rendered';
let readerWide = false;
let logFilter = 'all';
let logPinned = true;
let es = null;
let draftSaveTimer = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function latestRequest(thread) {
  if (!thread || !thread.requests || !thread.requests.length) return null;
  return thread.requests[thread.requests.length - 1];
}

function statusClass(status) {
  if (status === 'SAVED · VERIFIED') return 'teal';
  if (status === 'FAILED' || status === 'RECEIVED · SAVE FAILED') return 'maroon';
  if (
    ['SUBMITTING', 'SUBMITTED', 'RESEARCHING', 'RECEIVING', 'RECEIVED', 'SAVING'].includes(status)
  ) {
    return 'red';
  }
  return '';
}

function formatLocalTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function applyState(next) {
  state = next;
  if (state.activeThread) {
    currentMode = state.activeThread.mode || currentMode;
  }
  renderAll();
  maybeNotify();
}

function renderAll() {
  renderThreads();
  renderHeader();
  renderTimeline();
  renderReader();
  renderComposer();
  renderLogs();
}

function renderThreads() {
  const ul = $('#thread-list');
  ul.innerHTML = '';
  for (const t of state.threads || []) {
    const li = document.createElement('li');
    li.className = 'thread-item' + (t.id === state.activeThreadId ? ' selected' : '');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', t.id === state.activeThreadId ? 'true' : 'false');
    li.dataset.id = t.id;
    li.title = t.title;
    const ts = t.updatedAt ? formatLocalTime(t.updatedAt) : '';
    li.innerHTML = `
      <span class="dot ${t.statusDot || 'gray'}" aria-hidden="true"></span>
      <div class="thread-meta">
        <div class="thread-title">${escapeHtml(t.title)}</div>
        <div class="thread-sub"><span>${escapeHtml((t.mode || '').toUpperCase())}</span><span>${escapeHtml(ts)}</span></div>
      </div>
      <button type="button" class="thread-drop" data-drop="${t.id}" title="Drop from list" aria-label="Drop thread from list">×</button>
    `;
    li.addEventListener('click', (e) => {
      if (e.target.closest('[data-drop]')) return;
      activateThread(t.id);
    });
    ul.appendChild(li);
  }
  $$('.thread-drop', ul).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.del(`/api/threads/${btn.dataset.drop}`);
      const st = await api.get('/api/state');
      applyState(st);
    });
  });
}

function renderHeader() {
  const t = state.activeThread;
  const req = latestRequest(t);
  $('#active-title').textContent = t ? t.title : 'No Thread';
  const mode = t ? t.mode : currentMode;
  const modeEl = $('#header-mode');
  modeEl.textContent = (mode || '').toUpperCase();
  modeEl.classList.toggle('contents', mode === 'contents');
  const status = req ? req.status : 'DRAFT';
  const stEl = $('#header-status');
  stEl.textContent = status;
  stEl.className = 'status-word ' + statusClass(status);
}

function renderTimeline() {
  const box = $('#timeline');
  const t = state.activeThread;
  if (!t || !t.requests || !t.requests.length) {
    box.innerHTML = `
      <div class="empty-state" id="empty-state">
        <div class="readout">
          <div class="ro-row"><span class="ro-label">STATUS</span><span class="ro-value">NO RESULT YET</span></div>
          <div class="ro-row"><span class="ro-label">HINT</span><span class="ro-value subtle">Choose a mode, enter a prompt, press Submit</span></div>
        </div>
      </div>`;
    return;
  }
  box.innerHTML = '';
  // Show most recent first-ish — actually chronological, latest at bottom like chat; show last 5
  const reqs = t.requests.slice(-5);
  for (const req of reqs) {
    box.appendChild(buildRequestBlock(req));
  }
  box.scrollTop = box.scrollHeight;
}

function formatJobIdHtml(jobId) {
  if (!jobId) return `<span class="ro-value">—</span>`;
  const full = String(jobId);
  const truncated = full.length > 28 ? full.slice(0, 24) + '…' : full;
  return `<span class="ro-value job-id-cell">
    <button type="button" class="job-id-toggle" aria-expanded="false" aria-label="Expand job ID" title="Expand job ID">▸</button>
    <span class="job-id-text" data-full="${escapeHtml(full)}" data-short="${escapeHtml(truncated)}">${escapeHtml(truncated)}</span>
  </span>`;
}

function buildRequestBlock(req) {
  const el = document.createElement('article');
  el.className = 'request-block';
  el.dataset.requestId = req.id;

  const sched = req.schedule || {};
  const statusCls = statusClass(req.status);
  const running = ['SUBMITTING', 'SUBMITTED', 'RESEARCHING', 'RECEIVING', 'SAVING'].includes(req.status);
  const output =
    req.savedPaths && req.savedPaths.length
      ? req.savedPaths.map((p) => p.path).join('\n')
      : '—';

  let actions = '';
  if (req.status === 'TRACKING PAUSED' && req.jobId) {
    actions = `<div class="tracking-actions"><button type="button" class="btn btn-sm" data-resume="${req.id}">Resume Tracking</button></div>`;
  } else if (running && req.jobId && req.trackingActive) {
    actions = `<div class="tracking-actions"><button type="button" class="btn btn-sm" data-stop="${req.id}">Stop Local Polling</button></div>`;
  }

  let errorHtml = '';
  if (req.error) {
    errorHtml = `
      <div class="error-block">
        <h3>${escapeHtml(req.error.title || 'Error')}</h3>
        <div class="readout">
          <div class="ro-row"><span class="ro-label">OPERATION</span><span class="ro-value">${escapeHtml(req.error.operation || '—')}</span></div>
          <div class="ro-row"><span class="ro-label">STATUS</span><span class="ro-value maroon">${escapeHtml(String(req.error.status ?? '—'))}</span></div>
          <div class="ro-row"><span class="ro-label">MESSAGE</span><span class="ro-value">${escapeHtml(req.error.message || '')}</span></div>
          <div class="ro-row"><span class="ro-label">TIME</span><span class="ro-value">${escapeHtml(formatLocalTime(req.error.timestamp))}</span></div>
          <div class="ro-row"><span class="ro-label">JOB ID</span>${formatJobIdHtml(req.error.jobId || req.jobId)}</div>
        </div>
      </div>`;
  }

  el.innerHTML = `
    <div class="prompt-preview">${escapeHtml(req.input || (req.urls || []).join('\n') || '(no input)')}</div>
    <div class="readout">
      <div class="ro-row"><span class="ro-label">STATUS</span><span class="ro-value ${statusCls}">${running ? '<span class="activity" aria-hidden="true"></span>' : ''}${escapeHtml(req.status)}</span></div>
      <div class="ro-row"><span class="ro-label">MODE</span><span class="ro-value">${escapeHtml((req.mode || '').toUpperCase())}</span></div>
      <div class="ro-row"><span class="ro-label">SUBMITTED</span><span class="ro-value">${escapeHtml(formatLocalTime(req.submittedAt))}</span></div>
      <div class="ro-row"><span class="ro-label">ELAPSED</span><span class="ro-value">${escapeHtml(sched.elapsedLabel || '—')}</span></div>
      <div class="ro-row"><span class="ro-label">INTERVAL</span><span class="ro-value">${escapeHtml(sched.intervalLabel || '—')}</span></div>
      <div class="ro-row"><span class="ro-label">NEXT CHECK</span><span class="ro-value">${escapeHtml(sched.nextCheckLabel || '—')}</span></div>
      <div class="ro-row"><span class="ro-label">JOB ID</span>${formatJobIdHtml(req.jobId)}</div>
      <div class="ro-row"><span class="ro-label">OUTPUT</span><span class="ro-value path" data-copy-path="${escapeHtml(output)}">${escapeHtml(output)}</span></div>
    </div>
    ${actions}
    ${errorHtml}
  `;

  $$('[data-stop]', el).forEach((b) =>
    b.addEventListener('click', async () => {
      const r = await api.post(`/api/tracking/${b.dataset.stop}/stop`);
      applyState(r.state);
    })
  );
  $$('[data-resume]', el).forEach((b) =>
    b.addEventListener('click', async () => {
      const r = await api.post(`/api/tracking/${b.dataset.resume}/resume`);
      applyState(r.state);
    })
  );
  $$('[data-copy-path]', el).forEach((b) => {
    if (b.dataset.copyPath && b.dataset.copyPath !== '—') {
      b.addEventListener('click', () => {
        navigator.clipboard.writeText(b.dataset.copyPath).catch(() => {});
      });
    }
  });
  $$('.job-id-toggle', el).forEach((btn) => {
    btn.addEventListener('click', () => {
      const textEl = btn.parentElement.querySelector('.job-id-text');
      if (!textEl) return;
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      if (expanded) {
        btn.setAttribute('aria-expanded', 'false');
        btn.textContent = '▸';
        btn.title = 'Expand job ID';
        btn.setAttribute('aria-label', 'Expand job ID');
        textEl.textContent = textEl.dataset.short || textEl.dataset.full;
      } else {
        btn.setAttribute('aria-expanded', 'true');
        btn.textContent = '▾';
        btn.title = 'Collapse job ID';
        btn.setAttribute('aria-label', 'Collapse job ID');
        textEl.textContent = textEl.dataset.full;
      }
    });
  });
  return el;
}

function getActiveContent() {
  const req = latestRequest(state.activeThread);
  if (!req) return { markdown: '', pages: null, req: null };
  return {
    markdown: req.content || '',
    pages: req.contentsPages,
    req,
  };
}

function renderReader() {
  const { markdown, pages, req } = getActiveContent();
  const rendered = $('#reader-rendered');
  const raw = $('#reader-raw');
  const caption = $('#raw-caption');
  const saveAgain = $('#btn-save-again');

  if (req && req.status === 'RECEIVED · SAVE FAILED') {
    saveAgain.classList.remove('hidden');
  } else {
    saveAgain.classList.add('hidden');
  }

  if (!req || (!markdown && !(pages && pages.length))) {
    rendered.innerHTML = '<p class="empty-reader">STATUS  NO REPORT · submit a request to populate</p>';
    raw.textContent = '';
    return;
  }

  if (pages && pages.length && req.mode === 'contents') {
    rendered.innerHTML = pages
      .map((p, i) => {
        const path =
          req.savedPaths && req.savedPaths[i] ? req.savedPaths[i].path : '';
        const body = renderMarkdown(p.markdown || '');
        return `<div class="contents-page">
          <div class="contents-page-header">${escapeHtml(p.url || p.title || 'Page ' + (i + 1))}${path ? '<br/>→ ' + escapeHtml(path) : ''}</div>
          ${body}
        </div>`;
      })
      .join('');
    raw.textContent = pages.map((p) => p.markdown || '').join('\n\n---\n\n');
  } else {
    rendered.innerHTML = renderMarkdown(markdown);
    raw.textContent = markdown;
  }

  rendered.classList.toggle('hidden', readerTab !== 'rendered');
  raw.classList.toggle('hidden', readerTab !== 'raw');
  caption.classList.toggle('hidden', readerTab !== 'raw');
  rendered.classList.toggle('wide-width', readerWide);
  rendered.classList.toggle('reading-width', !readerWide);
  $('#btn-width').textContent = readerWide ? 'Reading' : 'Wide';
}

function renderMarkdown(md) {
  if (typeof marked !== 'undefined' && marked.parse) {
    return marked.parse(md, { async: false });
  }
  return `<pre>${escapeHtml(md)}</pre>`;
}

function renderComposer() {
  const t = state.activeThread;
  currentMode = t ? t.mode : currentMode;

  $$('.seg').forEach((s) => {
    const on = s.dataset.mode === currentMode;
    s.classList.toggle('active', on);
    s.setAttribute('aria-checked', on ? 'true' : 'false');
  });

  const urlsWrap = $('#urls-wrap');
  urlsWrap.classList.toggle('hidden', currentMode !== 'contents');

  $('#prompt').placeholder = MODE_PLACEHOLDERS[currentMode] || '';
  $('#composer-helper').textContent = MODE_HELPERS[currentMode] || '';

  // Don't clobber while typing if focused
  if (document.activeElement !== $('#prompt') && t) {
    $('#prompt').value = t.draft || '';
  }
  if (document.activeElement !== $('#urls-input') && t) {
    $('#urls-input').value = t.urlsDraft || '';
  }
}

function renderLogs() {
  const rows = $('#log-rows');
  const wasPinned = logPinned;
  const logs = (state.logs || []).filter((l) => logFilter === 'all' || l.severity === logFilter);
  $('#log-count').textContent = String((state.logs || []).length);

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

  if (wasPinned) rows.scrollTop = rows.scrollHeight;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function activateThread(id) {
  const r = await api.post(`/api/threads/${id}/activate`);
  applyState(r.state);
  $('#sidebar').classList.remove('open');
}

function scheduleDraftSave() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(saveDraft, 400);
}

async function saveDraft() {
  if (!state.activeThreadId) return;
  const draft = $('#prompt').value;
  const urlsDraft = $('#urls-input').value;
  try {
    const r = await api.patch(`/api/threads/${state.activeThreadId}`, {
      draft,
      urlsDraft,
      mode: currentMode,
    });
    // Soft update without full re-render of prompt
    state = r.state;
    renderThreads();
    renderHeader();
  } catch (_) {}
}

async function setMode(mode) {
  currentMode = mode;
  if (state.activeThreadId) {
    await api.patch(`/api/threads/${state.activeThreadId}`, { mode });
    const st = await api.get('/api/state');
    applyState(st);
  } else {
    renderComposer();
  }
}

async function submit() {
  if (!state.activeThreadId) {
    const created = await api.post('/api/threads', { mode: currentMode });
    applyState(created.state);
  }
  const input = $('#prompt').value;
  const urls =
    currentMode === 'contents'
      ? $('#urls-input').value.split(/\n+/).map((s) => s.trim()).filter(Boolean)
      : [];
  if (currentMode === 'contents' && !urls.length) {
    alert('Contents mode requires at least one URL');
    return;
  }
  if (currentMode !== 'contents' && !input.trim()) {
    alert('Enter a prompt');
    return;
  }
  if (currentMode === 'answers' && input.length > 400) {
    alert('Answers query max 400 characters');
    return;
  }
  const r = await api.post('/api/submit', {
    threadId: state.activeThreadId,
    mode: currentMode,
    input,
    urls,
  });
  applyState(r.state);
  // Clear draft after submit for research-like modes
  $('#prompt').value = '';
  if (currentMode !== 'contents') {
    await api.patch(`/api/threads/${state.activeThreadId}`, { draft: '' });
  }
}

function maybeNotify() {
  const req = latestRequest(state.activeThread);
  if (!req || !req.notifyPending) return;
  if (typeof Notification === 'undefined') {
    api.post(`/api/notify-ack/${req.id}`).catch(() => {});
    return;
  }
  if (Notification.permission === 'granted') {
    const title = state.activeThread?.title || 'Research Console';
    new Notification(title, {
      body: `${(req.mode || '').toUpperCase()} · ${req.status}`,
    });
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
  es.onerror = () => {
    // Browser will retry; also poll as backup
  };
}

async function refreshState() {
  const st = await api.get('/api/state');
  applyState(st);
}

function bindUI() {
  $('#btn-new-thread').addEventListener('click', async () => {
    const r = await api.post('/api/threads', { mode: currentMode });
    applyState(r.state);
    $('#prompt').focus();
  });

  $('#btn-sidebar-toggle').addEventListener('click', () => {
    $('#sidebar').classList.toggle('open');
  });

  $('#active-title').addEventListener('blur', async () => {
    if (!state.activeThreadId) return;
    const title = $('#active-title').textContent.trim() || 'Untitled';
    const r = await api.patch(`/api/threads/${state.activeThreadId}`, { title });
    applyState(r.state);
  });
  $('#active-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    }
  });

  $$('.seg').forEach((s) =>
    s.addEventListener('click', () => setMode(s.dataset.mode))
  );

  $('#prompt').addEventListener('input', scheduleDraftSave);
  $('#urls-input').addEventListener('input', scheduleDraftSave);

  $('#prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  $('#btn-submit').addEventListener('click', submit);

  $$('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      readerTab = tab.dataset.tab;
      $$('.tab').forEach((t) => {
        const on = t.dataset.tab === readerTab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      renderReader();
    })
  );

  $('#btn-copy').addEventListener('click', () => {
    const { markdown, pages, req } = getActiveContent();
    let text = markdown;
    if (req?.mode === 'contents' && pages) {
      text = pages.map((p) => p.markdown || '').join('\n\n---\n\n');
    }
    navigator.clipboard.writeText(text || '').catch(() => {});
  });

  $('#btn-open-file').addEventListener('click', async () => {
    const req = latestRequest(state.activeThread);
    const p = req?.savedPaths?.[0]?.path;
    if (!p) return;
    await api.post('/api/open-path', { path: p }).catch(() => {});
  });

  $('#btn-open-folder').addEventListener('click', async () => {
    const req = latestRequest(state.activeThread);
    let p = req?.savedPaths?.[0]?.path;
    if (p) {
      p = p.replace(/\/[^/]+$/, '') || p;
    } else {
      const s = await api.get('/api/settings');
      p = s.settings?.outputDir;
    }
    if (!p) return;
    await api.post('/api/open-path', { path: p }).catch(() => {});
  });

  $('#btn-save-again').addEventListener('click', async () => {
    const req = latestRequest(state.activeThread);
    if (!req) return;
    const r = await api.post(`/api/save-again/${req.id}`);
    applyState(r.state);
  });

  $('#btn-width').addEventListener('click', () => {
    readerWide = !readerWide;
    renderReader();
  });

  $('#btn-top').addEventListener('click', () => {
    const el = readerTab === 'raw' ? $('#reader-raw') : $('#reader-rendered');
    el.scrollTop = 0;
  });

  $('#btn-log-toggle').addEventListener('click', () => {
    const body = $('#log-body');
    const open = body.hasAttribute('hidden');
    if (open) body.removeAttribute('hidden');
    else body.setAttribute('hidden', '');
    $('#btn-log-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  $$('.log-filter').forEach((b) =>
    b.addEventListener('click', () => {
      logFilter = b.dataset.sev;
      $$('.log-filter').forEach((x) => x.classList.toggle('active', x === b));
      renderLogs();
    })
  );

  $('#log-rows').addEventListener('scroll', () => {
    const el = $('#log-rows');
    logPinned = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  });

  // Settings
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-key-save').addEventListener('click', async () => {
    const key = $('#key-input').value;
    await api.post('/api/key', { key });
    $('#key-input').value = '';
    await refreshSettingsUI();
  });
  $('#btn-key-delete').addEventListener('click', async () => {
    const dlg = $('#confirm-dialog');
    dlg.showModal();
    const result = await new Promise((resolve) => {
      dlg.addEventListener(
        'close',
        () => resolve(dlg.returnValue),
        { once: true }
      );
    });
    if (result === 'confirm') {
      await api.del('/api/key');
      await refreshSettingsUI();
    }
  });
  $('#btn-dir-save').addEventListener('click', async () => {
    await api.put('/api/settings', { outputDir: $('#dir-input').value });
    await refreshSettingsUI();
  });
  $('#btn-dir-open').addEventListener('click', async () => {
    const path = $('#dir-input').value;
    if (path) await api.post('/api/open-path', { path }).catch(() => {});
  });
  $('#btn-notif-request').addEventListener('click', async () => {
    if (typeof Notification !== 'undefined') {
      await Notification.requestPermission();
    }
    await refreshSettingsUI();
  });
  $('#btn-notif-test').addEventListener('click', () => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('You.com Research Console', { body: 'Test notification' });
    } else {
      alert('Notification permission not granted');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#settings-dialog').open && $('#settings-dialog').close();
      $('#confirm-dialog').open && $('#confirm-dialog').close();
      $('#sidebar').classList.remove('open');
      const body = $('#log-body');
      if (!body.hasAttribute('hidden')) {
        body.setAttribute('hidden', '');
        $('#btn-log-toggle').setAttribute('aria-expanded', 'false');
      }
    }
  });

  // Backup poll every 2s in case SSE drops
  setInterval(async () => {
    try {
      const st = await api.get('/api/state');
      // Only apply if something meaningful changed — cheap stringify
      if (JSON.stringify(st.activeThread) !== JSON.stringify(state.activeThread) ||
          st.threads?.length !== state.threads?.length) {
        applyState(st);
      } else if (st.activeThread) {
        // Still refresh schedule tick via soft merge
        state = st;
        renderHeader();
        renderTimeline();
        renderThreads();
      }
    } catch (_) {}
  }, 2000);
}

async function openSettings() {
  await refreshSettingsUI();
  $('#settings-dialog').showModal();
}

async function refreshSettingsUI() {
  const data = await api.get('/api/settings');
  const keyStatus = $('#key-status');
  keyStatus.textContent = data.key?.status || 'NO KEY';
  keyStatus.className = 'ro-value ' + (data.key?.present ? 'teal' : 'maroon');

  const dirStatus = $('#dir-status');
  const check = data.outputCheck || {};
  dirStatus.textContent = check.status || '—';
  dirStatus.className = 'ro-value ' + (check.ok ? 'teal' : 'maroon');
  $('#dir-path').textContent = check.path || data.settings?.outputDir || '—';
  $('#dir-input').value = data.settings?.outputDir || '';

  const perm =
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  $('#notif-perm').textContent = perm.toUpperCase();
}

async function init() {
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
    `<pre style="color:#8B0000;padding:16px">Failed to start UI: ${escapeHtml(err.message)}</pre>`
  );
});
