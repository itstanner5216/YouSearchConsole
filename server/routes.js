'use strict';

const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const envKey = require('./envKey');
const settings = require('./settings');
const stateStore = require('./stateStore');
const orchestrator = require('./orchestrator');
const presence = require('./presence');
const { getLogs, log, redact } = require('./logger');

function createRouter() {
  const router = express.Router();

  // --- Key ---
  router.get('/key', (_req, res) => {
    res.json(envKey.presence());
  });

  router.post('/key', (req, res) => {
    try {
      const key = req.body && req.body.key;
      envKey.setKey(key);
      log('info', 'API key saved', { operation: 'key.save', outcome: 'ok' });
      res.json(envKey.presence());
    } catch (err) {
      res.status(400).json({ error: envKey.safeError(err) });
    }
  });

  router.delete('/key', (_req, res) => {
    envKey.deleteKey();
    log('info', 'API key deleted', { operation: 'key.delete', outcome: 'ok' });
    res.json(envKey.presence());
  });

  // --- Settings ---
  router.get('/settings', (_req, res) => {
    const s = settings.load();
    const outputCheck = settings.validateOutputDir(s.outputDir);
    res.json({ settings: s, outputCheck, key: envKey.presence() });
  });

  router.put('/settings', (req, res) => {
    try {
      const result = settings.update(req.body || {});
      res.json({ ...result, key: envKey.presence() });
    } catch (err) {
      res.status(400).json({ error: redact(err.message) });
    }
  });

  // --- State / SSE ---
  router.get('/state', (_req, res) => {
    res.json(stateStore.getPublicState());
  });

  router.get('/events', (req, res) => {
    presence.attach(req);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    send({ type: 'state', state: stateStore.getPublicState() });

    const onState = (st) => send({ type: 'state', state: st });
    const onLog = (entry) => send({ type: 'log', entry });

    stateStore.setOnChange(onState);
    const { setOnAppend } = require('./logger');
    // Multiplex: keep prior + ours via wrapper list
    if (!global.__sseClients) global.__sseClients = new Set();
    const client = { onState, onLog, res };
    global.__sseClients.add(client);

    // Rebind broadcasters
    stateStore.setOnChange((st) => {
      for (const c of global.__sseClients) {
        try {
          c.onState(st);
        } catch (_) {}
      }
    });
    setOnAppend((entry) => {
      for (const c of global.__sseClients) {
        try {
          c.onLog(entry);
        } catch (_) {}
      }
    });

    req.on('close', () => {
      global.__sseClients.delete(client);
    });
  });

  // --- Threads ---
  router.get('/threads', (_req, res) => {
    res.json({ threads: stateStore.listSidebarThreads(), activeThreadId: stateStore.getPublicState().activeThreadId });
  });

  router.post('/threads', (req, res) => {
    const mode = req.body?.mode || 'frontier';
    const thread = stateStore.createThread(mode);
    res.status(201).json({ thread, state: stateStore.getPublicState() });
  });

  router.patch('/threads/:id', (req, res) => {
    try {
      const thread = stateStore.updateThread(req.params.id, req.body || {});
      res.json({ thread, state: stateStore.getPublicState() });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  router.post('/threads/:id/activate', (req, res) => {
    try {
      const thread = stateStore.setActive(req.params.id);
      res.json({ thread, state: stateStore.getPublicState() });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  router.delete('/threads/:id', (req, res) => {
    const result = stateStore.dropFromSidebar(req.params.id);
    res.json({ ...result, state: stateStore.getPublicState() });
  });

  router.get('/threads/:id', (req, res) => {
    const thread = stateStore.getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    res.json({ thread });
  });

  // --- Submit / tracking / save ---
  router.post('/submit', async (req, res) => {
    try {
      const { threadId, mode, input, urls } = req.body || {};
      if (!threadId) return res.status(400).json({ error: 'threadId required' });
      const request = await orchestrator.submit({ threadId, mode, input, urls });
      res.json({ request, state: stateStore.getPublicState() });
    } catch (err) {
      res.status(err.status || 500).json({ error: redact(err.message) });
    }
  });

  router.post('/tracking/:requestId/stop', (req, res) => {
    const request = orchestrator.pauseTracking(req.params.requestId, 'user_stop');
    if (!request) return res.status(404).json({ error: 'Request not found' });
    res.json({ request, state: stateStore.getPublicState() });
  });

  router.post('/tracking/:requestId/resume', (req, res) => {
    try {
      const request = orchestrator.resumeTracking(req.params.requestId);
      res.json({ request, state: stateStore.getPublicState() });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  router.post('/save-again/:requestId', async (req, res) => {
    try {
      const request = await orchestrator.saveAgain(req.params.requestId);
      res.json({ request, state: stateStore.getPublicState() });
    } catch (err) {
      res.status(err.status || 400).json({ error: redact(err.message) });
    }
  });

  router.post('/notify-ack/:requestId', (req, res) => {
    const request = orchestrator.ackNotify(req.params.requestId);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    res.json({ request });
  });

  // --- Logs ---
  router.get('/logs', (_req, res) => {
    res.json({ logs: getLogs() });
  });

  // --- Open path ---
  router.post('/open-path', (req, res) => {
    const target = req.body?.path;
    if (!target || typeof target !== 'string') {
      return res.status(400).json({ error: 'path required' });
    }
    const abs = path.resolve(target);
    // Safety: only open under configured output dir or project
    execFile('xdg-open', [abs], (err) => {
      if (err) {
        // Fallback for environments without xdg-open
        log('error', 'open-path failed', {
          operation: 'open-path',
          details: { path: abs, error: err.message },
        });
        return res.status(500).json({ error: err.message, path: abs });
      }
      res.json({ ok: true, path: abs });
    });
  });

  return router;
}

module.exports = { createRouter };
