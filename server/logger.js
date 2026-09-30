'use strict';

const MAX_LOGS = 500;

/** @type {Array<object>} */
let logs = [];
/** @type {(entry: object) => void} */
let onAppend = () => {};

function redact(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value
      .replace(/YDC_API_KEY\s*=\s*[^\s&]+/gi, 'YDC_API_KEY=***')
      .replace(/X-API-Key["\s:]+[A-Za-z0-9_\-]+/gi, 'X-API-Key: ***')
      .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
      .replace(/api[_-]?key["\s:=]+[A-Za-z0-9_\-]{8,}/gi, 'api_key=***');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/api.?key|secret|token|authorization|password/i.test(k)) {
        out[k] = '***';
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

function setLogs(existing) {
  logs = Array.isArray(existing) ? existing.slice(-MAX_LOGS) : [];
}

function getLogs() {
  return logs.slice();
}

function setOnAppend(fn) {
  onAppend = typeof fn === 'function' ? fn : () => {};
}

/**
 * @param {'info'|'api'|'state'|'success'|'error'} severity
 * @param {string} message
 * @param {object} [details]
 */
function log(severity, message, details = {}) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    severity,
    message: String(redact(message)),
    threadId: details.threadId || null,
    jobId: details.jobId || null,
    operation: details.operation || null,
    outcome: details.outcome || null,
    details: redact(details.details || {}),
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
  try {
    onAppend(entry);
  } catch (_) {
    /* ignore listener errors */
  }
  return entry;
}

module.exports = {
  log,
  getLogs,
  setLogs,
  setOnAppend,
  redact,
  MAX_LOGS,
};
