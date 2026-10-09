'use strict';

/**
 * Single scheduling function for research polling.
 * Elapsed is measured from successful submission (ms).
 *
 * 0–3 min:   30s
 * 3–6 min:   15s (Frontier's median run is about 5 min)
 * 6–15 min:  30s
 * ≥15 min:   failsafe → one last check, then FAILED
 *
 * A job sent to You.com can't be stopped, so tracking never pauses; it ends
 * when You.com answers or at the failsafe: a result not in by 15 minutes isn't coming.
 */

const SCHEDULE = [
  { untilMs: 3 * 60 * 1000, intervalMs: 30 * 1000 },
  { untilMs: 6 * 60 * 1000, intervalMs: 15 * 1000 },
  { untilMs: 15 * 60 * 1000, intervalMs: 30 * 1000 },
];

const FAILSAFE_MS = 15 * 60 * 1000;

/**
 * @param {number} elapsedMs
 * @returns {{ intervalMs: number, exhausted: boolean, phase: string }}
 */
function getInterval(elapsedMs) {
  const e = Math.max(0, Number(elapsedMs) || 0);
  if (e >= FAILSAFE_MS) {
    return { intervalMs: 0, exhausted: true, phase: 'failsafe' };
  }
  for (const row of SCHEDULE) {
    if (e < row.untilMs) {
      return {
        intervalMs: row.intervalMs,
        exhausted: false,
        phase: `${row.intervalMs / 1000}s`,
      };
    }
  }
  return { intervalMs: 0, exhausted: true, phase: 'failsafe' };
}

/**
 * Compute readout fields from submission time and optional last-check time.
 * @param {number|string|Date} submittedAt
 * @param {number} [nowMs]
 * @param {number} [lastCheckAtMs] — when the last poll happened; next check = last + interval
 */
function computeSchedule(submittedAt, nowMs = Date.now(), lastCheckAtMs = null) {
  const submitted = new Date(submittedAt).getTime();
  const now = nowMs;
  const elapsedMs = Math.max(0, now - submitted);
  const { intervalMs, exhausted, phase } = getInterval(elapsedMs);

  let nextCheckMs = 0;
  if (!exhausted && intervalMs > 0) {
    const anchor = lastCheckAtMs != null ? lastCheckAtMs : submitted;
    const due = anchor + intervalMs;
    nextCheckMs = Math.max(0, due - now);
    // If overdue, next check is "now" (0) — poller should fire immediately
  }

  return {
    elapsedMs,
    elapsedLabel: formatDuration(elapsedMs),
    intervalMs,
    intervalLabel: exhausted ? '—' : `${intervalMs / 1000}s`,
    nextCheckMs,
    nextCheckLabel: exhausted ? '—' : formatCountdown(nextCheckMs),
    exhausted,
    phase,
    failsafeMs: FAILSAFE_MS,
  };
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatCountdown(ms) {
  const sec = Math.ceil(ms / 1000);
  return `${sec}s`;
}

module.exports = {
  SCHEDULE,
  FAILSAFE_MS,
  getInterval,
  computeSchedule,
  formatDuration,
  formatCountdown,
};
