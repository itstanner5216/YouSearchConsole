'use strict';

const { log } = require('./logger');
const settings = require('./settings');
const stateStore = require('./stateStore');
const youClient = require('./youClient');
const poller = require('./poller');
const saver = require('./saver');

/** @type {Map<string, NodeJS.Timeout>} */
const timers = new Map();

function clearTimers(requestId) {
  if (timers.has(requestId)) {
    clearTimeout(timers.get(requestId));
    timers.delete(requestId);
  }
}

function refreshSchedule(request) {
  if (!request.submittedAt) {
    request.schedule = null;
    return null;
  }
  const sched = poller.computeSchedule(
    request.submittedAt,
    Date.now(),
    request.lastCheckAt ? new Date(request.lastCheckAt).getTime() : null
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
  // One request at a time per thread; other threads run alongside it.
  const last = thread.requests && thread.requests[thread.requests.length - 1];
  if (last && RUNNING.includes(last.status)) {
    const err = new Error(`This thread is still running a request (${last.status}). Start a new thread to run another alongside it.`);
    err.status = 409;
    throw err;
  }
  const m = stateStore.normalizeMode(mode || thread.mode);
  // The draft is the composer's: the page clears it when it sends and puts the query back if sending fails.
  stateStore.updateThread(threadId, { mode: m });

  const req = stateStore.createRequest(threadId, {
    mode: m,
    input: input || '',
    urls: urls || [],
    status: 'SUBMITTING',
  });

  log('state', 'SUBMITTING', { threadId, operation: 'submit', details: { mode: m, requestId: req.id } });

  try {
    if (m === 'frontier' || m === 'exhaustive') {
      const data = await youClient.submitResearch(input, m);
      stateStore.updateRequest(req.id, {
        status: 'SUBMITTED',
        jobId: data.task_id,
        submittedAt: new Date().toISOString(),
        trackingActive: true,
        rawResponse: data,
        streamUrl: data.stream_url || null,
      });
      log('state', 'SUBMITTED', {
        threadId,
        jobId: data.task_id,
        operation: 'submit',
        outcome: 'ok',
      });
      // Move to RESEARCHING and start polling
      stateStore.updateRequest(req.id, { status: 'RESEARCHING' });
      scheduleNextPoll(req.id);
      return stateStore.getRequest(req.id).request;
    }

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
    stateStore.updateRequest(req.id, {
      status: 'FAILED',
      error: {
        title: 'Submission failed',
        operation: 'submit',
        status: err.status || null,
        message: err.message || String(err),
        timestamp: new Date().toISOString(),
        jobId: null,
      },
      trackingActive: false,
    });
    log('error', 'submit failed', {
      threadId,
      operation: 'submit',
      outcome: 'failed',
      details: { message: err.message, status: err.status },
    });
    return stateStore.getRequest(req.id).request;
  }
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

  req.lastCheckAt = new Date().toISOString();
  stateStore.touch();

  try {
    const data = await youClient.pollResearch(req.jobId);
    const status = String(data.status || '').toLowerCase();

    if (status === 'queued') {
      stateStore.updateRequest(requestId, { status: 'SUBMITTED', rawResponse: data });
      pollAgainOrEnd(requestId, `You.com still had the job queued after ${TRACKING_LIMIT}, so the app stopped waiting for it.`);
      return;
    }
    if (status === 'running') {
      stateStore.updateRequest(requestId, { status: 'RESEARCHING', rawResponse: data });
      pollAgainOrEnd(requestId, `You.com still had the job running after ${TRACKING_LIMIT}, so the app stopped waiting for it.`);
      return;
    }
    if (status === 'completed') {
      clearTimers(requestId);
      stateStore.updateRequest(requestId, {
        status: 'RECEIVING',
        trackingActive: false,
        rawResponse: data,
      });
      const markdown = saver.extractResearchMarkdown(data);
      const sources = data.result?.output?.sources || data.output?.sources || null;
      stateStore.updateRequest(requestId, {
        status: 'RECEIVED',
        content: markdown,
        sources,
      });
      log('state', 'RECEIVED', {
        threadId: req.threadId,
        jobId: req.jobId,
        operation: 'research.receive',
        outcome: 'ok',
      });
      await saveRequestContent(requestId);
      return;
    }
    if (status === 'failed' || status === 'cancelled') {
      clearTimers(requestId);
      stateStore.updateRequest(requestId, {
        status: 'FAILED',
        trackingActive: false,
        rawResponse: data,
        error: {
          title: status === 'cancelled' ? 'Research cancelled' : 'Research failed',
          operation: 'research',
          status: null,
          message: plainText(data.error) || plainText(data.message) || (data.error ? JSON.stringify(data.error) : `Task ${status}`),
          timestamp: new Date().toISOString(),
          jobId: req.jobId,
        },
      });
      log('error', `research ${status}`, {
        threadId: req.threadId,
        jobId: req.jobId,
        operation: 'research',
        outcome: status,
      });
      return;
    }
    // Unknown status — keep polling
    pollAgainOrEnd(requestId, `You.com hadn't finished the job after ${TRACKING_LIMIT} (last status: ${status || 'none'}), so the app stopped waiting for it.`);
  } catch (err) {
    // A rejected key or a job You.com doesn't know won't recover; anything else is retried on the schedule.
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
      details: { message: err.message },
    });
    pollAgainOrEnd(requestId, `The app couldn't reach You.com for the result within ${TRACKING_LIMIT} of tracking. Last error: ${err.message}`);
  }
}

// An API field is shown only when it is plain text (or carries a text message), never as "[object Object]".
function plainText(v) {
  return typeof v === 'string' ? v : v && typeof v.message === 'string' ? v.message : '';
}

const TRACKING_LIMIT = `${poller.FAILSAFE_MS / 60000} minutes`;

// Keep checking until You.com answers; once tracking passes the failsafe, the check just made was the last.
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
  clearTimers(requestId);
  const req = stateStore.getRequest(requestId).request;
  stateStore.updateRequest(requestId, {
    status: 'FAILED',
    trackingActive: false,
    error: { title, operation: 'research.poll', status, message, timestamp: new Date().toISOString(), jobId: req.jobId },
  });
  log('error', title, {
    threadId: req.threadId,
    jobId: req.jobId,
    operation: 'research.poll',
    outcome: 'failed',
    details: { message },
  });
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
      const result = saver.atomicWrite(check.path, content, { when });
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

// On startup, every job You.com is still working on picks up tracking where it left off.
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
  saveAgain,
  saveRequestContent,
  trackInFlight,
  inFlightCount,
  clearTimers,
  refreshSchedule,
  scheduleNextPoll,
  doPoll,
  ackNotify,
  timers,
};
