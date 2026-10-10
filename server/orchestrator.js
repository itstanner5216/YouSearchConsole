'use strict';

const { randomUUID } = require('crypto');
const { log } = require('./logger');
const settings = require('./settings');
const stateStore = require('./stateStore');
const youClient = require('./youClient');
const poller = require('./poller');
const saver = require('./saver');
const providers = require('./providers');

/** @type {Map<string, NodeJS.Timeout>} */
const timers = new Map();

function clearTimers(requestId) {
  if (timers.has(requestId)) {
    clearTimeout(timers.get(requestId));
    timers.delete(requestId);
  }
}

// How long this request may take; requests saved before providers existed are You.com's 15 minutes.
function limitOf(request) {
  return request.limitMs || poller.FAILSAFE_MS;
}
const minutes = (ms) => `${ms / 60000} minutes`;

function refreshSchedule(request) {
  if (!request.submittedAt) {
    request.schedule = null;
    return null;
  }
  const sched = poller.computeSchedule(
    request.submittedAt,
    Date.now(),
    request.lastCheckAt ? new Date(request.lastCheckAt).getTime() : null,
    limitOf(request)
  );
  request.schedule = sched;
  return sched;
}

// Statuses during which a request is still in flight.
const RUNNING = ['SUBMITTING', 'SUBMITTED', 'RESEARCHING', 'RECEIVING', 'RECEIVED', 'SAVING'];

async function submit({ threadId, mode, input, urls }) {
  const thread = stateStore.getThread(threadId);
  if (!thread) {
    const err = new Error('Thread not found');
    err.status = 404;
    throw err;
  }
  assertIdle(thread);
  const m = stateStore.normalizeMode(mode || thread.mode);
  // The draft is the composer's: the page clears it when it sends and puts the query back if sending fails.
  stateStore.updateThread(threadId, { mode: m });

  const research = m === 'frontier' || m === 'exhaustive';
  const req = stateStore.createRequest(threadId, {
    provider: 'you',
    mode: m,
    input: input || '',
    urls: urls || [],
    status: 'SUBMITTING',
    limitMs: research ? providers.levelOf(providers.get('you'), m).limitMs : null,
  });

  log('state', 'SUBMITTING', { threadId, operation: 'submit', details: { mode: m, requestId: req.id } });

  if (research) {
    await startRun(req.id);
    return stateStore.getRequest(req.id).request;
  }

  try {

    if (m === 'answers') {
      const data = await youClient.submitAnswers(input);
      const markdown = saver.extractAnswersMarkdown(data);
      stateStore.updateRequest(req.id, {
        status: 'RECEIVED',
        submittedAt: new Date().toISOString(),
        content: markdown,
        rawResponse: data,
        sources: data.citations || data.results || null,
      });
      log('state', 'RECEIVED', { threadId, operation: 'answers', outcome: 'ok' });
      await saveRequestContent(req.id);
      return stateStore.getRequest(req.id).request;
    }

    if (m === 'contents') {
      const data = await youClient.submitContents(urls && urls.length ? urls : parseUrls(input));
      const pages = saver.extractContentsPages(data);
      stateStore.updateRequest(req.id, {
        status: 'RECEIVED',
        submittedAt: new Date().toISOString(),
        contentsPages: pages,
        content: pages.map((p) => p.markdown).join('\n\n---\n\n'),
        rawResponse: data,
      });
      log('state', 'RECEIVED', {
        threadId,
        operation: 'contents',
        outcome: 'ok',
        details: { pages: pages.length },
      });
      await saveRequestContent(req.id);
      return stateStore.getRequest(req.id).request;
    }

    throw Object.assign(new Error(`Unknown mode: ${m}`), { status: 400 });
  } catch (err) {
    const message = providers.scrub(err.message || String(err));
    stateStore.updateRequest(req.id, {
      status: 'FAILED',
      error: {
        title: 'Submission failed',
        operation: 'submit',
        status: err.status || null,
        message,
        timestamp: new Date().toISOString(),
        jobId: null,
      },
      trackingActive: false,
    });
    log('error', 'submit failed', {
      threadId,
      operation: 'submit',
      outcome: 'failed',
      details: { message, status: err.status },
    });
    return stateStore.getRequest(req.id).request;
  }
}

// One request at a time per thread (a fan-out counts as one); other threads run alongside it.
function assertIdle(thread) {
  const busy = (thread.requests || []).find((r) => RUNNING.includes(r.status));
  if (busy) {
    const err = new Error(`This thread is still running a request (${busy.status}). Start a new thread to run another alongside it.`);
    err.status = 409;
    throw err;
  }
}

/**
 * Sends one prompt to several providers at once: every provider with a saved key, a chosen
 * group, or just one (see providers.resolveSelection). Each provider's run is its own request,
 * tracked and saved on its own; they share a batchId. Resolves once every provider has
 * accepted the work or failed to; reports arrive later through state updates.
 */
async function research({ threadId, input, providers: selection } = {}) {
  const thread = stateStore.getThread(threadId);
  if (!thread) throw Object.assign(new Error('Thread not found'), { status: 404 });
  const text = String(input || '').trim();
  if (!text) throw Object.assign(new Error('Write a research prompt first.'), { status: 400 });
  assertIdle(thread);
  const picks = providers.resolveSelection(selection);

  const batchId = randomUUID();
  const reqs = picks.map(({ provider: p, level }) =>
    stateStore.createRequest(threadId, {
      provider: p.id,
      mode: level.id,
      input: text,
      status: 'SUBMITTING',
      batchId,
      limitMs: level.limitMs,
    })
  );
  log('state', 'SUBMITTING', {
    threadId,
    operation: 'research',
    details: { batchId, providers: picks.map(({ provider: p, level }) => `${p.id}:${level.id}`) },
  });

  await Promise.all(reqs.map((r) => startRun(r.id)));
  return { batchId, requests: reqs.map((r) => stateStore.getRequest(r.id).request) };
}

/**
 * Background work per request (a stream being read); tests wait on it with settle(). Nothing
 * else awaits it, so an unexpected error marks the request failed here instead of escaping
 * as an unhandled rejection, which would stop the server.
 */
const pending = new Map();
function inBackground(requestId, work) {
  const run = work
    .catch((err) => fail(requestId, { title: 'Research failed', operation: 'research.stream', status: err.status || null, message: err.message || String(err) }))
    .finally(() => pending.delete(requestId));
  pending.set(requestId, run);
}
async function settle() {
  while (pending.size) await Promise.all([...pending.values()]);
}

/** Hands a request to its provider. Resolves once the provider has accepted it or it has failed. */
async function startRun(requestId) {
  const req = stateStore.getRequest(requestId).request;
  const p = providers.get(req.provider);
  const level = p && providers.levelOf(p, req.mode);
  const at = { threadId: req.threadId, operation: 'submit', details: { provider: req.provider, level: req.mode } };
  try {
    if (!p || !level) throw Object.assign(new Error(`Unknown provider option: ${req.provider}:${req.mode}`), { status: 400 });

    if (p.kind === 'poll') {
      const { jobId, raw, extra } = await p.start(req.input, level.id);
      stateStore.updateRequest(requestId, {
        status: 'SUBMITTED',
        jobId,
        submittedAt: new Date().toISOString(),
        trackingActive: true,
        rawResponse: raw,
        ...(extra || {}),
      });
      log('state', 'SUBMITTED', { ...at, jobId, outcome: 'ok' });
      stateStore.updateRequest(requestId, { status: 'RESEARCHING' });
      scheduleNextPoll(requestId);
      return;
    }

    stateStore.updateRequest(requestId, { status: 'SUBMITTED', submittedAt: new Date().toISOString() });

    if (p.kind === 'once') {
      const result = await p.run(req.input, level.id);
      await receive(requestId, result);
      return;
    }

    // stream: the run is accepted once the provider answers with its stream; the report is read in the background.
    const guard = providers.streamGuard(level.limitMs);
    let res;
    try {
      res = await p.open(req.input, level.id, guard);
    } catch (err) {
      guard.done();
      throw err;
    }
    stateStore.updateRequest(requestId, { status: 'RESEARCHING' });
    log('state', 'RESEARCHING', { ...at, operation: 'research.stream', outcome: 'ok' });
    inBackground(requestId, readStream(requestId, p, res, guard));
  } catch (err) {
    fail(requestId, {
      title: 'Submission failed',
      operation: 'submit',
      status: err.status || null,
      message: err.message || String(err),
    });
  }
}

async function readStream(requestId, p, res, guard) {
  let result;
  try {
    result = await p.collect(res, guard);
  } catch (err) {
    fail(requestId, { title: 'Research failed', operation: 'research.stream', status: err.status || null, message: err.message || String(err) });
    return;
  } finally {
    guard.done();
  }
  await receive(requestId, result);
}

// The report is in: keep it, then write it to disk.
async function receive(requestId, { content, sources, raw }) {
  clearTimers(requestId);
  const found = stateStore.getRequest(requestId);
  if (!found) return;
  const req = found.request;
  stateStore.updateRequest(requestId, {
    status: 'RECEIVED',
    trackingActive: false,
    content,
    sources: sources && sources.length ? sources : null,
    ...(raw !== undefined ? { rawResponse: raw } : {}),
  });
  log('state', 'RECEIVED', {
    threadId: req.threadId,
    jobId: req.jobId,
    operation: 'research.receive',
    outcome: 'ok',
    details: { provider: req.provider || 'you' },
  });
  await saveRequestContent(requestId);
}

// Error text can come from a provider, so any saved key in it is masked before it's kept or logged.
function fail(requestId, { title, operation, status, message }) {
  clearTimers(requestId);
  message = providers.scrub(message);
  const found = stateStore.getRequest(requestId);
  if (!found) {
    log('error', title, { operation, outcome: 'failed', details: { requestId, message, status, note: 'request no longer in state' } });
    return;
  }
  const req = found.request;
  stateStore.updateRequest(requestId, {
    status: 'FAILED',
    trackingActive: false,
    error: { title, operation, status, message, timestamp: new Date().toISOString(), jobId: req.jobId || null },
  });
  log('error', title, {
    threadId: req.threadId,
    jobId: req.jobId,
    operation,
    outcome: 'failed',
    details: { provider: req.provider || 'you', message, status },
  });
}

function parseUrls(text) {
  return String(text || '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function scheduleNextPoll(requestId) {
  clearTimers(requestId);
  const found = stateStore.getRequest(requestId);
  if (!found) return;
  const req = found.request;
  if (!req.trackingActive) return;

  const sched = refreshSchedule(req);
  stateStore.touch();
  if (!sched) return;

  // Past the failsafe the next check is the last one, and it runs now.
  const delay = sched.exhausted ? 0 : Math.max(0, sched.nextCheckMs || sched.intervalMs);
  const t = setTimeout(() => {
    timers.delete(requestId);
    doPoll(requestId).catch((err) => {
      log('error', 'poll error', {
        operation: 'research.poll',
        jobId: req.jobId,
        details: { error: err.message },
      });
    });
  }, delay);
  if (typeof t.unref === 'function') t.unref();
  timers.set(requestId, t);
}

async function doPoll(requestId) {
  const found = stateStore.getRequest(requestId);
  if (!found || !found.request.trackingActive) return;
  const req = found.request;
  const p = providers.get(req.provider);
  if (!p || p.kind !== 'poll') {
    endTracking(requestId, { title: 'Research failed', status: null, message: `The app can't check runs for provider "${req.provider}".` });
    return;
  }
  const limit = minutes(limitOf(req));

  req.lastCheckAt = new Date().toISOString();
  stateStore.touch();

  try {
    const r = await p.check(req.jobId, req.mode);

    if (r.state === 'queued') {
      stateStore.updateRequest(requestId, { status: 'SUBMITTED', rawResponse: r.raw });
      pollAgainOrEnd(requestId, `${p.name} still had the job queued after ${limit}, so the app stopped waiting for it.`);
      return;
    }
    if (r.state === 'running') {
      stateStore.updateRequest(requestId, { status: 'RESEARCHING', rawResponse: r.raw });
      pollAgainOrEnd(requestId, `${p.name} still had the job running after ${limit}, so the app stopped waiting for it.`);
      return;
    }
    if (r.state === 'completed') {
      clearTimers(requestId);
      stateStore.updateRequest(requestId, { status: 'RECEIVING', trackingActive: false, rawResponse: r.raw });
      await receive(requestId, r);
      return;
    }
    if (r.state === 'failed') {
      stateStore.updateRequest(requestId, { rawResponse: r.raw });
      fail(requestId, { title: r.title, operation: 'research', status: null, message: r.message });
      return;
    }
    // Unknown status — keep polling
    pollAgainOrEnd(requestId, `${p.name} hadn't finished the job after ${limit} (last status: ${r.status || 'none'}), so the app stopped waiting for it.`);
  } catch (err) {
    // A rejected key or a job the provider doesn't know won't recover; anything else is retried on the schedule.
    if (err.code === 'NO_API_KEY' || err.status === 401 || err.status === 403 || err.status === 404) {
      endTracking(requestId, {
        title: err.status === 404 ? 'Research job not found' : 'API authentication error',
        status: err.status || 401,
        message: err.message,
      });
      return;
    }
    log('error', 'poll transient error — will retry', {
      jobId: req.jobId,
      operation: 'research.poll',
      details: { provider: p.id, message: providers.scrub(err.message) },
    });
    pollAgainOrEnd(requestId, `The app couldn't reach ${p.name} for the result within ${limit} of tracking. Last error: ${err.message}`);
  }
}

// Keep checking until the provider answers; once tracking passes the failsafe, the check just made was the last.
function pollAgainOrEnd(requestId, timeoutMessage) {
  const found = stateStore.getRequest(requestId);
  if (!found) return;
  const sched = refreshSchedule(found.request);
  if (sched && sched.exhausted) {
    endTracking(requestId, { title: 'Research timed out', status: null, message: timeoutMessage });
    return;
  }
  scheduleNextPoll(requestId);
}

function endTracking(requestId, { title, status, message }) {
  fail(requestId, { title, operation: 'research.poll', status, message });
}

async function saveRequestContent(requestId) {
  const found = stateStore.getRequest(requestId);
  if (!found) return null;
  const req = found.request;
  const cfg = settings.load();
  const check = settings.validateOutputDir(cfg.outputDir);

  stateStore.updateRequest(requestId, { status: 'SAVING' });
  log('state', 'SAVING', { threadId: req.threadId, jobId: req.jobId, operation: 'save' });

  if (!check.ok) {
    stateStore.updateRequest(requestId, {
      status: 'RECEIVED · SAVE FAILED',
      error: {
        title: 'Save failed',
        operation: 'save',
        status: null,
        message: check.error || check.status,
        timestamp: new Date().toISOString(),
        jobId: req.jobId,
      },
    });
    return stateStore.getRequest(requestId).request;
  }

  const when = new Date();
  const savedPaths = [];

  try {
    if (req.mode === 'contents' && Array.isArray(req.contentsPages) && req.contentsPages.length) {
      // Same second base; suffix -01, -02...
      // Use same `when` so base timestamp matches; suffixes differentiate
      for (let i = 0; i < req.contentsPages.length; i++) {
        const page = req.contentsPages[i];
        const result = saver.atomicWrite(check.path, page.markdown, {
          when,
          pageIndex: i + 1,
        });
        if (!result.ok) throw new Error(result.error);
        savedPaths.push({ path: result.path, url: page.url, title: page.title });
      }
    } else {
      const content = req.content != null ? req.content : '';
      // Other providers' reports carry the provider in the filename; You.com's keep the plain name.
      const tag = req.provider && req.provider !== 'you' ? req.provider : null;
      const result = saver.atomicWrite(check.path, content, { when, tag });
      if (!result.ok) throw new Error(result.error);
      savedPaths.push({ path: result.path });
    }

    stateStore.updateRequest(requestId, {
      status: 'SAVED · VERIFIED',
      savedPaths,
      error: null,
      notifyPending: true,
    });
    log('success', 'SAVED · VERIFIED', {
      threadId: req.threadId,
      jobId: req.jobId,
      operation: 'save',
      outcome: 'verified',
      details: { paths: savedPaths.map((p) => p.path) },
    });
  } catch (err) {
    stateStore.updateRequest(requestId, {
      status: 'RECEIVED · SAVE FAILED',
      error: {
        title: 'Save failed',
        operation: 'save',
        status: null,
        message: err.message || String(err),
        timestamp: new Date().toISOString(),
        jobId: req.jobId,
      },
    });
    log('error', 'RECEIVED · SAVE FAILED', {
      threadId: req.threadId,
      jobId: req.jobId,
      operation: 'save',
      outcome: 'failed',
      details: { message: err.message },
    });
  }
  return stateStore.getRequest(requestId).request;
}

async function saveAgain(requestId) {
  const found = stateStore.getRequest(requestId);
  if (!found) {
    const err = new Error('Request not found');
    err.status = 404;
    throw err;
  }
  const req = found.request;
  if (req.content == null && !(req.contentsPages && req.contentsPages.length)) {
    const err = new Error('No retained content to save');
    err.status = 400;
    throw err;
  }
  log('info', 'Save Again', {
    threadId: req.threadId,
    jobId: req.jobId,
    operation: 'save.again',
  });
  return saveRequestContent(requestId);
}

// On startup, every job a provider is still working on picks up tracking where it left off.
function trackInFlight() {
  for (const t of stateStore.getRawState().threads) {
    for (const r of t.requests || []) {
      if (!r.trackingActive || !r.jobId) continue;
      log('state', 'tracking continues after restart', { threadId: t.id, jobId: r.jobId, operation: 'tracking.restart' });
      scheduleNextPoll(r.id);
    }
  }
}

// How many requests are still in flight; the server stays up after the window closes until this is 0.
function inFlightCount() {
  let n = 0;
  for (const t of stateStore.getRawState().threads) {
    for (const r of t.requests || []) if (RUNNING.includes(r.status)) n += 1;
  }
  return n;
}

// When the last in-flight request is due to have ended: its start plus its own limit, and a minute to save.
function inFlightDeadline() {
  let latest = 0;
  for (const t of stateStore.getRawState().threads) {
    for (const r of t.requests || []) {
      if (!RUNNING.includes(r.status)) continue;
      const start = Date.parse(r.submittedAt || r.createdAt) || 0; // no time on record: it doesn't hold the server
      latest = Math.max(latest, start + limitOf(r) + 60 * 1000);
    }
  }
  return latest;
}

function ackNotify(requestId) {
  const found = stateStore.getRequest(requestId);
  if (!found) return null;
  stateStore.updateRequest(requestId, { notifyPending: false });
  log('info', 'notification fired', {
    threadId: found.request.threadId,
    jobId: found.request.jobId,
    operation: 'notify',
    outcome: found.request.status,
  });
  return found.request;
}

module.exports = {
  submit,
  research,
  settle,
  saveAgain,
  saveRequestContent,
  trackInFlight,
  inFlightCount,
  inFlightDeadline,
  clearTimers,
  refreshSchedule,
  scheduleNextPoll,
  doPoll,
  ackNotify,
  timers,
};
