'use strict';

const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const envKey = require('./envKey');
const settings = require('./settings');
const stateStore = require('./stateStore');
const orchestrator = require('./orchestrator');
const providers = require('./providers');
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

  // --- Research providers (You.com's key also stays at /key) ---
  router.get('/providers', (_req, res) => {
    res.json({ providers: providers.list() });
  });

  function providerFor(req, res) {
    const p = providers.get(String(req.params.id).toLowerCase());
    if (!p) res.status(404).json({ error: `Unknown provider "${req.params.id}"` });
    return p;
  }

  router.post('/providers/:id/key', (req, res) => {
    const p = providerFor(req, res);
    if (!p) return;
    try {
      envKey.setKey(req.body && req.body.key, p.keyName);
      log('info', `${p.name} API key saved`, { operation: 'key.save', outcome: 'ok', details: { provider: p.id } });
      res.json(envKey.presence(p.keyName));
    } catch (err) {
      res.status(400).json({ error: envKey.safeError(err) });
    }
  });

  router.delete('/providers/:id/key', (req, res) => {
    const p = providerFor(req, res);
    if (!p) return;
    envKey.deleteKey(p.keyName);
    log('info', `${p.name} API key deleted`, { operation: 'key.delete', outcome: 'ok', details: { provider: p.id } });
    res.json(envKey.presence(p.keyName));
  });

  // One prompt to every provider with a key ("all" or omitted), a chosen group, or one:
  // providers: ["tavily", "exa:xhigh", { provider: "you", level: "exhaustive" }]
  router.post('/research', async (req, res) => {
    try {
      const { threadId, input, providers: selection } = req.body || {};
      if (!threadId) return res.status(400).json({ error: 'threadId required' });
      const result = await orchestrator.research({ threadId, input, providers: selection });
      res.json({ ...result, state: stateStore.getPublicState() });
    } catch (err) {
      res.status(err.status || 500).json({ error: redact(err.message) });
    }
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
    presence.attach(res);
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
