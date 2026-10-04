'use strict';

// Exit-when-closed: when the launcher starts the server it sets YDC_EXIT_WHEN_CLOSED=1.
// Every open page holds the /api/events stream; when the last one closes and none
// returns within the grace period (long enough for a reload), the server shuts down.
// If no page ever connects (the browser failed to open), it shuts down too.

const ENABLED = process.env.YDC_EXIT_WHEN_CLOSED === '1';
const GRACE_MS = Number(process.env.YDC_EXIT_GRACE_MS) || 10000;
const FIRST_CONNECT_MS = Number(process.env.YDC_FIRST_CONNECT_MS) || 60000;

let open = 0;
let timer = null;
let onIdle = () => {};

function arm(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (open === 0) onIdle();
  }, ms);
}

function start(callback) {
  onIdle = callback;
  if (ENABLED) arm(FIRST_CONNECT_MS);
}

function attach(req) {
  open += 1;
  clearTimeout(timer);
  req.on('close', () => {
    open -= 1;
    if (ENABLED && open === 0) arm(GRACE_MS);
  });
}

module.exports = { start, attach, get enabled() { return ENABLED; }, get open() { return open; } };
