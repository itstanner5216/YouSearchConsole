'use strict';

const { log } = require('./logger');
const settings = require('./settings');
const stateStore = require('./stateStore');
const youClient = require('./youClient');
const poller = require('./poller');
const saver = require('./saver');

/** @type {Map<string, NodeJS.Timeout>} */
const timers = new Map();
/** @type {Map<string, NodeJS.Timeout>} */
const tickTimers = new Map();

function clearTimers(requestId) {
  if (timers.has(requestId)) {
    clearTimeout(timers.get(requestId));
    timers.delete(requestId);
  }
  if (tickTimers.has(requestId)) {
    clearInterval(tickTimers.get(requestId));
    tickTimers.delete(requestId);
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

function startTick(requestId) {
  if (tickTimers.has(requestId)) return;
  const iv = setInterval(() => {
    const found = stateStore.getRequest(requestId);
    if (!found || !found.request.trackingActive) {
      clearInterval(iv);
      tickTimers.delete(requestId);
      return;
    }
    refreshSchedule(found.request);
    stateStore.touch();
  }, 1000);
  if (typeof iv.unref === 'function') iv.unref();
  tickTimers.set(requestId, iv);
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
  stateStore.updateThread(threadId, { mode: m, draft: input || '', urlsDraft: (urls || []).join('\n') });

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
      startTick(req.id);
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

  if (!sched || sched.exhausted) {
    pauseTracking(requestId, 'failsafe_15min');
    return;
  }

  const delay = Math.max(0, sched.nextCheckMs || sched.intervalMs);
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

  // Failsafe check before poll
  const pre = refreshSchedule(req);
  if (pre && pre.exhausted) {
    pauseTracking(requestId, 'failsafe_15min');
    return;
  }

  req.lastCheckAt = new Date().toISOString();
  stateStore.touch();

  try {
    const data = await youClient.pollResearch(req.jobId);
    const status = String(data.status || '').toLowerCase();

    if (status === 'queued') {
      stateStore.updateRequest(requestId, { status: 'SUBMITTED', rawResponse: data });
      scheduleNextPoll(requestId);
      return;
    }
    if (status === 'running') {
      stateStore.updateRequest(requestId, { status: 'RESEARCHING', rawResponse: data });
      scheduleNextPoll(requestId);
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
          message: data.error || data.message || `Task ${status}`,
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
    scheduleNextPoll(requestId);
  } catch (err) {
    // Transient poll errors: keep tracking unless it's auth
    if (err.code === 'NO_API_KEY' || err.status === 401 || err.status === 403) {
      stateStore.updateRequest(requestId, {
        status: 'FAILED',
        trackingActive: false,
        error: {
          title: 'API authentication error',
          operation: 'research.poll',
          status: err.status || 401,
          message: err.message,
          timestamp: new Date().toISOString(),
          jobId: req.jobId,
        },
      });
      clearTimers(requestId);
      return;
    }
    log('error', 'poll transient error — will retry', {
      jobId: req.jobId,
      operation: 'research.poll',
      details: { message: err.message },
    });
    scheduleNextPoll(requestId);
  }
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

function pauseTracking(requestId, reason = 'user_stop') {
  clearTimers(requestId);
  const found = stateStore.getRequest(requestId);
  if (!found) return null;
  const req = found.request;
  if (['SAVED · VERIFIED', 'FAILED', 'RECEIVED · SAVE FAILED', 'RECEIVED', 'SAVING'].includes(req.status)) {
    // Terminal / post-receive — just stop timers
    stateStore.updateRequest(requestId, { trackingActive: false });
    return stateStore.getRequest(requestId).request;
  }
  stateStore.updateRequest(requestId, {
    status: 'TRACKING PAUSED',
    trackingActive: false,
    pauseReason: reason,
  });
  refreshSchedule(req);
  log('state', 'TRACKING PAUSED', {
    threadId: req.threadId,
    jobId: req.jobId,
    operation: 'tracking.pause',
    details: { reason },
  });
  return stateStore.getRequest(requestId).request;
}

function resumeTracking(requestId) {
  const found = stateStore.getRequest(requestId);
  if (!found) {
    const err = new Error('Request not found');
    err.status = 404;
    throw err;
  }
  const req = found.request;
  if (!req.jobId) {
    const err = new Error('No job ID to resume');
    err.status = 400;
    throw err;
  }
  // Resume from appropriate cadence based on original submittedAt
  stateStore.updateRequest(requestId, {
    status: 'RESEARCHING',
    trackingActive: true,
    pauseReason: null,
  });
  // Reset lastCheckAt so next poll uses interval from now relative to schedule
  // Keep lastCheckAt so we don't immediately spam; if overdue, nextCheckMs=0
  log('state', 'tracking resumed', {
    threadId: req.threadId,
    jobId: req.jobId,
    operation: 'tracking.resume',
  });
  startTick(requestId);
  scheduleNextPoll(requestId);
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

function stopAllTracking() {
  for (const [id] of timers) {
    pauseTracking(id, 'app_close');
  }
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
  pauseTracking,
  resumeTracking,
  saveAgain,
  saveRequestContent,
  stopAllTracking,
  clearTimers,
  refreshSchedule,
  scheduleNextPoll,
  doPoll,
  ackNotify,
  timers,
};
