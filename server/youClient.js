'use strict';

const { getKey } = require('./envKey');
const { log, redact } = require('./logger');

const RESEARCH_URL = 'https://api.you.com/v1/research';
const ANSWER_URL = 'https://api.you.com/v1/answer';
const CONTENTS_URL = 'https://ydc-index.io/v1/contents';

/** Injectable fetch for tests */
let fetchImpl = globalThis.fetch.bind(globalThis);

function setFetch(fn) {
  fetchImpl = fn;
}

function resetFetch() {
  fetchImpl = globalThis.fetch.bind(globalThis);
}

function authHeaders() {
  const key = getKey();
  if (!key) {
    const err = new Error('NO API KEY');
    err.code = 'NO_API_KEY';
    err.status = 401;
    throw err;
  }
  return {
    'X-API-Key': key,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function parseError(res) {
  let body = '';
  try {
    body = await res.text();
  } catch (_) {
    body = '';
  }
  let message = body;
  try {
    const j = JSON.parse(body);
    message = j.message || j.error || j.detail || body;
  } catch (_) {
    /* keep text */
  }
  const err = new Error(redact(String(message || res.statusText || 'Request failed')));
  err.status = res.status;
  err.body = redact(body);
  return err;
}

/**
 * Build Research request body. Always background: true.
 */
function buildResearchBody(input, effort) {
  const research_effort = effort === 'exhaustive' ? 'exhaustive' : 'frontier';
  return {
    input: String(input),
    research_effort,
    background: true,
  };
}

function buildAnswersBody(query) {
  const q = String(query);
  if (q.length > 400) {
    const err = new Error('Answers query max 400 characters');
    err.status = 400;
    throw err;
  }
  return { query: q };
}

function buildContentsBody(urls) {
  const list = Array.isArray(urls) ? urls : String(urls || '').split(/\n+/);
  const cleaned = list.map((u) => String(u).trim()).filter(Boolean);
  if (!cleaned.length) {
    const err = new Error('Contents requires at least one URL');
    err.status = 400;
    throw err;
  }
  return { urls: cleaned, formats: ['markdown'] };
}

async function submitResearch(input, effort) {
  const body = buildResearchBody(input, effort);
  log('api', 'research submit', {
    operation: 'research.submit',
    details: { research_effort: body.research_effort, background: true, inputLen: body.input.length },
  });
  const res = await fetchImpl(RESEARCH_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  const data = await res.json();
  log('api', 'research job accepted', {
    operation: 'research.submit',
    outcome: 'accepted',
    jobId: data.task_id,
    details: { status: data.status, type: data.type },
  });
  return data;
}

async function pollResearch(taskId) {
  const url = `${RESEARCH_URL}/${encodeURIComponent(taskId)}`;
  log('api', 'research poll', { operation: 'research.poll', jobId: taskId });
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: authHeaders(),
  });
  if (!res.ok) throw await parseError(res);
  const data = await res.json();
  log('state', `research status ${data.status}`, {
    operation: 'research.poll',
    jobId: taskId,
    outcome: data.status,
  });
  return data;
}

async function submitAnswers(query) {
  const body = buildAnswersBody(query);
  log('api', 'answers submit', {
    operation: 'answers.submit',
    details: { queryLen: body.query.length },
  });
  const res = await fetchImpl(ANSWER_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  const data = await res.json();
  log('api', 'answers received', { operation: 'answers.submit', outcome: 'ok' });
  return data;
}

async function submitContents(urls) {
  const body = buildContentsBody(urls);
  log('api', 'contents submit', {
    operation: 'contents.submit',
    details: { urlCount: body.urls.length },
  });
  const res = await fetchImpl(CONTENTS_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  const data = await res.json();
  log('api', 'contents received', {
    operation: 'contents.submit',
    outcome: 'ok',
    details: { count: Array.isArray(data) ? data.length : undefined },
  });
  return data;
}

module.exports = {
  RESEARCH_URL,
  ANSWER_URL,
  CONTENTS_URL,
  setFetch,
  resetFetch,
  buildResearchBody,
  buildAnswersBody,
  buildContentsBody,
  submitResearch,
  pollResearch,
  submitAnswers,
  submitContents,
  authHeaders,
};
