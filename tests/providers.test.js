'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const envKey = require('../server/envKey');
const settings = require('../server/settings');
const stateStore = require('../server/stateStore');
const youClient = require('../server/youClient');
const providers = require('../server/providers');
const orchestrator = require('../server/orchestrator');
const logger = require('../server/logger');
const { isolateDataDir } = require('./helpers');

const KEY_NAMES = ['YDC_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'TINYFISH_API_KEY', 'JINA_API_KEY', 'KEENABLE_API_KEY'];
const MIN = 60 * 1000;

// ---------- fetch mocks ----------

function jsonRes(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => null },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

/** A streamed 200 whose body yields the given chunks, then (if hang) waits until aborted. */
function streamRes(chunks, { signal, hang = false, delayMs = 0 } = {}) {
  const enc = new TextEncoder();
  async function* body() {
    for (const c of chunks) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      yield enc.encode(c);
    }
    if (hang) {
      await new Promise((_, reject) => {
        if (signal.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
  }
  return { ok: true, status: 200, statusText: 'OK', headers: { get: () => 'text/event-stream' }, body: body() };
}

/** Splits text into pieces of n characters, so SSE lines land across chunk boundaries. */
function pieces(text, n) {
  const out = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}

const sse = (events) => events.map((e) => (typeof e === 'string' ? e : `data: ${JSON.stringify(e)}\r\n\r\n`)).join('');
const chunk = (delta, extra = {}) => ({ id: 'evt', object: 'chat.completion.chunk', choices: [{ delta, ...extra }] });

/** Routes each call by method + URL; anything unexpected fails the test instead of reaching the network. */
function router(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method, headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
    for (const [pattern, handler] of routes) {
      const [m, u] = pattern.split(' ');
      if (m === method && (u.endsWith('*') ? url.startsWith(u.slice(0, -1)) : url === u)) return handler(url, opts, calls);
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  fn.calls = calls;
  return fn;
}

// ---------- isolation: temp data dir, temp .env, no real keys from the shell ----------

let isolation;
let saved;
function setup() {
  isolation = isolateDataDir('ydc-prov-');
  settings.update({ outputDir: isolation.outputDir });
  stateStore.setRawState({ threads: [], activeThreadId: null, lruOrder: [] });
  saved = { YDC_ENV_PATH: process.env.YDC_ENV_PATH };
  for (const k of KEY_NAMES) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const envFile = path.join(isolation.dataDir, '.env');
  fs.writeFileSync(envFile, '', 'utf8');
  process.env.YDC_ENV_PATH = envFile;
  envKey.rebindPaths({ envPath: envFile });
  providers.setFetch(router([]));
  youClient.setFetch(router([]));
}
function teardown() {
  for (const id of [...orchestrator.timers.keys()]) orchestrator.clearTimers(id);
  providers.resetFetch();
  youClient.resetFetch();
  for (const k of KEY_NAMES) delete process.env[k];
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  envKey.rebindPaths({});
  isolation.restore();
}
const key = (name, value) => envKey.setKey(value, name);
const p = (id) => providers.get(id);

// ---------- selection ----------

describe('providers: choosing who runs', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('"all" (or nothing) means every provider with a saved key, at its default level', () => {
    key('TAVILY_API_KEY', 'tvly-test-0001');
    key('EXA_API_KEY', 'exa-test-0001');
    for (const sel of ['all', undefined, null]) {
      const picks = providers.resolveSelection(sel).map((x) => `${x.provider.id}:${x.level.id}`);
      assert.deepEqual(picks, ['tavily:pro', 'exa:high']);
    }
  });

  it('"all" with no key saved anywhere is refused', () => {
    assert.throws(() => providers.resolveSelection('all'), { status: 400, message: 'No provider has an API key saved.' });
  });

  it('takes ids, id:level and objects; drops repeats; keeps order', () => {
    const picks = providers
      .resolveSelection(['tinyfish', 'EXA:xhigh', { provider: 'you', level: 'exhaustive' }, { id: 'jina', level: 'medium' }, 'tinyfish:deep'])
      .map((x) => `${x.provider.id}:${x.level.id}`);
    assert.deepEqual(picks, ['tinyfish:deep', 'exa:xhigh', 'you:exhaustive', 'jina:medium']);
    assert.deepEqual(providers.resolveSelection('keenable').map((x) => x.provider.id), ['keenable']);
  });

  it('names the choices when a provider or option is unknown, and never falls back to You.com', () => {
    assert.throws(() => providers.resolveSelection(['perplexity']), {
      status: 400,
      message: 'Unknown provider "perplexity". Choices: you, tavily, exa, tinyfish, jina, keenable.',
    });
    assert.throws(() => providers.resolveSelection(['exa:ultra']), { status: 400, message: 'Exa has no "ultra" option. Choices: high, xhigh.' });
    assert.throws(() => providers.resolveSelection([{}]), { status: 400 });
    assert.throws(() => providers.resolveSelection([':pro']), { status: 400 });
    assert.throws(() => providers.resolveSelection([]), { status: 400, message: 'Choose at least one provider.' });
  });

  it('lists providers with their options and key presence, never a key', () => {
    key('TAVILY_API_KEY', 'tvly-secret-value-0001');
    const list = providers.list();
    assert.deepEqual(list.map((x) => x.id), ['you', 'tavily', 'exa', 'tinyfish', 'jina', 'keenable']);
    const tf = list.find((x) => x.id === 'tinyfish');
    assert.deepEqual(tf.levels, [
      { id: 'deep', label: 'Deep', limitMinutes: 20 },
      { id: 'standard', label: 'Standard', limitMinutes: 15 },
    ]);
    assert.equal(tf.defaultLevel, 'deep');
    assert.deepEqual(list.find((x) => x.id === 'tavily').key, { present: true, status: 'KEY SAVED' });
    assert.deepEqual(tf.key, { present: false, status: 'NO KEY' });
    assert.ok(!JSON.stringify(list).includes('tvly-secret'));
  });

  it("rejects a key with spaces or line breaks, which would break the .env file", () => {
    assert.throws(() => envKey.setKey('abc\nEVIL=1', 'EXA_API_KEY'), /can't contain spaces or line breaks/);
    assert.equal(envKey.hasKey('EXA_API_KEY'), false);
  });
});

// ---------- streams ----------

describe('providers: Tavily stream', () => {
  beforeEach(setup);
  afterEach(teardown);

  const events = [
    chunk({ role: 'assistant', tool_calls: { type: 'tool_call', tool_call: [{ name: 'Planning', id: 'a' }] } }),
    chunk({
      tool_calls: {
        type: 'tool_response',
        tool_response: [{ name: 'WebSearch', id: 'b', sources: [{ url: 'https://a.example/1', title: 'A one' }, { url: 'https://b.example/2', title: 'B two' }] }],
      },
    }),
    chunk({ content: '# Report\n\nRISC-V is open [1](https://a.example/1). ' }),
    chunk({ content: 'Ünïcode — ok 🚀.' }),
    chunk({ sources: [{ url: 'https://a.example/1', title: 'A one' }, { url: 'https://c.example/3', title: 'C three' }] }),
    'event: done\r\ndata: [DONE]\r\n\r\n',
  ];

  it('sends the SDK request, reads lines split across chunks, and lists unlinked sources', async () => {
    key('TAVILY_API_KEY', 'tvly-test-key-0001');
    // 7-byte pieces cut through "data:", JSON, \r\n and a multi-byte character.
    // Live Tavily streams name every chunk `event: chat.completion.chunk`.
    const text = sse(events).replace(/data: \{/g, 'event: chat.completion.chunk\r\ndata: {');
    const bytes = new TextEncoder().encode(text);
    const fetchFn = router([
      [
        'POST https://api.tavily.com/research',
        (_u, opts) => {
          const parts = [];
          for (let i = 0; i < bytes.length; i += 7) parts.push(bytes.slice(i, i + 7));
          const res = streamRes([], { signal: opts.signal });
          res.body = (async function* () {
            for (const b of parts) yield b;
          })();
          return res;
        },
      ],
    ]);
    providers.setFetch(fetchFn);
    const guard = providers.streamGuard(15 * MIN);
    const res = await p('tavily').open('Compare RISC-V and ARM', 'pro', guard);
    const out = await p('tavily').collect(res, guard);
    guard.done();

    const call = fetchFn.calls[0];
    assert.equal(call.headers.Authorization, 'Bearer tvly-test-key-0001');
    assert.deepEqual(call.body, { input: 'Compare RISC-V and ARM', model: 'pro', stream: true, citation_format: 'numbered' });
    assert.ok(out.content.startsWith('# Report\n\nRISC-V is open [1](https://a.example/1). Ünïcode — ok 🚀.'));
    assert.deepEqual(out.sources.map((s) => s.url), ['https://a.example/1', 'https://b.example/2', 'https://c.example/3']);
    assert.match(out.content, /## Sources\n\n1\. \[A one\]\(https:\/\/a\.example\/1\)\n2\. \[B two\]\(https:\/\/b\.example\/2\)\n3\. \[C three\]\(https:\/\/c\.example\/3\)\n$/);
  });

  it("shows Tavily's own error text, with the key masked", async () => {
    key('TAVILY_API_KEY', 'tvly-test-key-0002');
    providers.setFetch(
      router([['POST https://api.tavily.com/research', () => jsonRes(401, { detail: { error: 'Unauthorized: invalid API key tvly-test-key-0002.' } })]])
    );
    const guard = providers.streamGuard(15 * MIN);
    await assert.rejects(p('tavily').open('q', 'mini', guard), (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.message, 'Unauthorized: invalid API key ***.');
      return true;
    });
    guard.done();
  });

  it('a stream that goes quiet ends with how much had arrived', async () => {
    key('TAVILY_API_KEY', 'tvly-test-key-0003');
    providers.setFetch(
      router([['POST https://api.tavily.com/research', (_u, opts) => streamRes([sse([chunk({ content: 'Partial report' })])], { signal: opts.signal, hang: true })]])
    );
    const guard = providers.streamGuard(15 * MIN, 150);
    const keepAlive = setInterval(() => {}, 1000); // the guard's timers are unref'd; a real socket would hold the loop
    try {
      const res = await p('tavily').open('q', 'pro', guard);
      await assert.rejects(p('tavily').collect(res, guard), { message: "Tavily's stream sent nothing for 0s after 14 characters of the report." });
    } finally {
      guard.done();
      clearInterval(keepAlive);
    }
  });

  it('a stream past its total limit is stopped', async () => {
    key('TAVILY_API_KEY', 'tvly-test-key-0004');
    providers.setFetch(router([['POST https://api.tavily.com/research', (_u, opts) => streamRes([], { signal: opts.signal, hang: true })]]));
    const guard = providers.streamGuard(120, 10 * MIN);
    const keepAlive = setInterval(() => {}, 1000);
    try {
      const res = await p('tavily').open('q', 'pro', guard);
      await assert.rejects(p('tavily').collect(res, guard), { message: "Tavily's stream ran past 0s." });
    } finally {
      guard.done();
      clearInterval(keepAlive);
    }
  });

  async function tavilyRun(body) {
    providers.setFetch(router([['POST https://api.tavily.com/research', () => streamRes(pieces(body, 9))]]));
    const guard = providers.streamGuard(15 * MIN);
    try {
      const res = await p('tavily').open('q', 'pro', guard);
      return await p('tavily').collect(res, guard);
    } finally {
      guard.done();
    }
  }

  it('a stream that closes before "done" fails instead of saving half a report', async () => {
    key('TAVILY_API_KEY', 'tvly-test-key-0006');
    await assert.rejects(tavilyRun(sse([chunk({ content: 'Partial report' })])), {
      message: "Tavily's stream closed before the run finished after 14 characters of the report.",
    });
    await assert.rejects(tavilyRun(''), { message: "Tavily's stream closed before the run finished." });
    // "done" may come as its own event, with or without data, in either field order.
    for (const end of ['event: done\n\n', 'event: done\ndata: {}\n\n', 'data: {}\nevent: done\n\n', 'event: done']) {
      const out = await tavilyRun(sse([chunk({ content: 'Whole report' })]) + end);
      assert.equal(out.content, 'Whole report');
    }
  });

  it("an error event is Tavily's own message, JSON or not", async () => {
    key('TAVILY_API_KEY', 'tvly-test-key-0007');
    await assert.rejects(tavilyRun(sse([chunk({ content: 'Some' }), { id: 'x', object: 'error', error: 'An error occurred while streaming the research task' }])), {
      message: 'Tavily reported an error: An error occurred while streaming the research task',
    });
    await assert.rejects(tavilyRun('event: error\ndata: Research quota exceeded\n\n'), { message: 'Tavily reported an error: Research quota exceeded' });
    await assert.rejects(tavilyRun('event: error\n\n'), { message: 'Tavily reported an error: no details given' });
  });

  it('a stream that ends without any report text fails', async () => {
    key('TAVILY_API_KEY', 'tvly-test-key-0005');
    providers.setFetch(router([['POST https://api.tavily.com/research', () => streamRes([sse([chunk({ sources: [] }), 'event: done\n'])])]]));
    const guard = providers.streamGuard(15 * MIN);
    const res = await p('tavily').open('q', 'pro', guard);
    await assert.rejects(p('tavily').collect(res, guard), { message: "Tavily's stream ended without a report." });
    guard.done();
  });
});

describe('providers: Jina DeepSearch stream', () => {
  beforeEach(setup);
  afterEach(teardown);

  async function run(events, level = 'high') {
    key('JINA_API_KEY', 'jina_test_key_000000001');
    const fetchFn = router([['POST https://deepsearch.jina.ai/v1/chat/completions', (_u, opts) => streamRes(pieces(sse(events), 5), { signal: opts.signal })]]);
    providers.setFetch(fetchFn);
    const guard = providers.streamGuard(15 * MIN);
    try {
      const res = await p('jina').open('Why is the sky blue?', level, guard);
      return { out: await p('jina').collect(res, guard), calls: fetchFn.calls };
    } finally {
      guard.done();
    }
  }

  it('drops the thinking, keeps the answer, and gathers cited then read URLs', async () => {
    const { out, calls } = await run(
      [
        chunk({ type: 'think', content: '<think>' }),
        chunk({ type: 'think', content: 'searching for Rayleigh…' }),
        chunk({ type: 'think', content: '</think>' }),
        chunk({ content: 'Rayleigh scattering [^1].' }),
        { ...chunk({ content: '', annotations: [{ type: 'url_citation', url_citation: { url: 'https://x.example/r', title: 'Rayleigh' } }] }, { finish_reason: 'stop' }), readURLs: ['https://x.example/r', 'https://y.example/s'], visitedURLs: ['https://z.example/t'] },
        'data: [DONE]\n\n',
      ],
      'medium'
    );
    assert.equal(calls[0].headers.Authorization, 'Bearer jina_test_key_000000001');
    assert.deepEqual(calls[0].body, {
      model: 'jina-deepsearch-v1',
      messages: [{ role: 'user', content: 'Why is the sky blue?' }],
      stream: true,
      reasoning_effort: 'medium',
      max_returned_urls: 20,
    });
    assert.ok(out.content.startsWith('Rayleigh scattering [^1].'));
    assert.ok(!out.content.includes('think'));
    assert.deepEqual(out.sources, [
      { url: 'https://x.example/r', title: 'Rayleigh' },
      { url: 'https://y.example/s', title: '' },
      { url: 'https://z.example/t', title: '' },
    ]);
  });

  it("DeepSearch's error chunk is the failure message", async () => {
    await assert.rejects(run([chunk({ type: 'think', content: '<think>hm' }), chunk({ type: 'error', content: 'Budget exhausted' }, { finish_reason: 'error' })]), {
      message: 'Jina reported an error: Budget exhausted',
    });
  });

  it('a stream that stops mid-thought fails instead of saving the thinking', async () => {
    await assert.rejects(run([chunk({ content: '<think>still going' })]), { message: "Jina's stream closed before DeepSearch finished." });
  });

  it("a stream that closes before DeepSearch's last chunk fails with how much had arrived", async () => {
    await assert.rejects(run([chunk({ content: '<think>hm</think>' }, { finish_reason: 'thinking_end' }), chunk({ content: 'Half an answer' })]), {
      message: "Jina's stream closed before DeepSearch finished after 14 characters of the report.",
    });
  });

  it('a finished run with no answer after the thinking fails', async () => {
    await assert.rejects(run([chunk({ content: '<think>hm</think>' }, { finish_reason: 'thinking_end' }), chunk({ content: '' }, { finish_reason: 'stop' })]), {
      message: "Jina's stream ended before DeepSearch gave its answer.",
    });
  });
});

// ---------- polled providers ----------

describe('providers: Exa and TinyFish runs', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('Exa: start, then completed with grounding citations', async () => {
    key('EXA_API_KEY', 'exa-test-key-0001');
    const fetchFn = router([
      ['POST https://api.exa.ai/agent/runs', () => jsonRes(200, { id: 'run_1', status: 'queued' })],
      [
        'GET https://api.exa.ai/agent/runs/run_1',
        () =>
          jsonRes(200, {
            id: 'run_1',
            status: 'completed',
            output: { text: 'Exa report body.', grounding: [{ field: 'text', citations: [{ url: 'https://e.example/1', title: 'E1' }] }] },
          }),
      ],
    ]);
    providers.setFetch(fetchFn);
    const started = await p('exa').start('q', 'xhigh');
    assert.equal(started.jobId, 'run_1');
    assert.deepEqual(fetchFn.calls[0].body, { query: 'q', effort: 'xhigh' });
    assert.equal(fetchFn.calls[0].headers['x-api-key'], 'exa-test-key-0001');
    const done = await p('exa').check('run_1');
    assert.equal(done.state, 'completed');
    assert.equal(done.content, 'Exa report body.\n\n## Sources\n\n1. [E1](https://e.example/1)\n');
  });

  it('Exa: a failed run without a message says how it stopped; an empty one fails', async () => {
    key('EXA_API_KEY', 'exa-test-key-0002');
    providers.setFetch(
      router([
        ['GET https://api.exa.ai/agent/runs/f', () => jsonRes(200, { id: 'f', status: 'failed', stopReason: 'budget' })],
        ['GET https://api.exa.ai/agent/runs/e', () => jsonRes(200, { id: 'e', status: 'completed', output: { text: '  ' } })],
        ['GET https://api.exa.ai/agent/runs/x', () => jsonRes(401, { error: { type: 'auth', code: 'invalid_key', message: 'Invalid API key' } })],
      ])
    );
    const f = await p('exa').check('f');
    assert.equal(f.state, 'failed');
    assert.equal(f.message, 'Exa ended the run (failed, stop reason: budget).');
    assert.equal((await p('exa').check('e')).message, 'Exa finished the run but returned no report.');
    await assert.rejects(p('exa').check('x'), { status: 401, message: 'Invalid API key' });
  });

  it('TinyFish: refuses a prompt over 2,000 characters before calling', async () => {
    key('TINYFISH_API_KEY', 'tf-test-key-0001');
    const fetchFn = router([]);
    providers.setFetch(fetchFn);
    await assert.rejects(p('tinyfish').start('x'.repeat(2001), 'deep'), { status: 400, message: 'TinyFish takes prompts up to 2,000 characters; this one is 2,001.' });
    // Characters, not UTF-16 units: 2,001 emoji are 4,002 units.
    await assert.rejects(p('tinyfish').start('🚀'.repeat(2001), 'deep'), { message: 'TinyFish takes prompts up to 2,000 characters; this one is 2,001.' });
    assert.equal(fetchFn.calls.length, 0);
    providers.setFetch(router([['POST https://agent.tinyfish.ai/v1/automation/run-research-async', () => jsonRes(200, { research_run_id: 'rr_e' })]]));
    assert.equal((await p('tinyfish').start('🚀'.repeat(2000), 'deep')).jobId, 'rr_e');
  });

  it('TinyFish: deep result with URL citations; TIMED_OUT carries its error', async () => {
    key('TINYFISH_API_KEY', 'tf-test-key-0002');
    const fetchFn = router([
      ['POST https://agent.tinyfish.ai/v1/automation/run-research-async', () => jsonRes(200, { research_run_id: 'rr_1', error: null })],
      [
        'GET https://agent.tinyfish.ai/v1/research-run/rr_1',
        () => jsonRes(200, { status: 'COMPLETED', deep_result: { result: 'Deep report [1].', citations: ['https://t.example/a', 'https://t.example/a'] } }),
      ],
      ['GET https://agent.tinyfish.ai/v1/research-run/rr_2', () => jsonRes(200, { status: 'TIMED_OUT', error: { code: 'RUN_TIMEOUT', message: 'Run exceeded its time budget' } })],
      ['GET https://agent.tinyfish.ai/v1/research-run/rr_3', () => jsonRes(403, { code: 'FORBIDDEN', message: 'Research is not enabled for this key' })],
    ]);
    providers.setFetch(fetchFn);
    const started = await p('tinyfish').start('q', 'deep');
    assert.equal(started.jobId, 'rr_1');
    assert.deepEqual(fetchFn.calls[0].body, { query: 'q', mode: 'deep' });
    assert.equal(fetchFn.calls[0].headers['X-API-Key'], 'tf-test-key-0002');
    const done = await p('tinyfish').check('rr_1');
    assert.equal(done.content, 'Deep report [1].\n\n## Sources\n\n1. [https://t.example/a](https://t.example/a)\n');
    const late = await p('tinyfish').check('rr_2');
    assert.deepEqual([late.state, late.title, late.message], ['failed', 'Research timed out', 'RUN_TIMEOUT: Run exceeded its time budget']);
    await assert.rejects(p('tinyfish').check('rr_3'), { status: 403, message: 'Research is not enabled for this key' });
  });

  it('Keenable: search results become a Markdown list; no credits is shown as Keenable says it', async () => {
    key('KEENABLE_API_KEY', 'keen_test_key_00000001');
    const fetchFn = router([
      [
        'POST https://api.keenable.ai/v1/search',
        (_u, opts) =>
          JSON.parse(opts.body).query === 'broke'
            ? jsonRes(402, { message: 'Out of credits' })
            : jsonRes(200, {
                results: [
                  { url: 'https://k.example/1', title: 'K [one]', description: 'First.', snippet: 'Snip  one', published_at: '2026-09-01T10:00:00Z' },
                  { url: 'https://k.example/2', title: 'K two', description: 'Second.' },
                ],
              }),
      ],
    ]);
    providers.setFetch(fetchFn);
    const out = await p('keenable').run('riscv  news');
    assert.deepEqual(fetchFn.calls[0].body, { query: 'riscv  news', mode: 'pro', max_results: 20 });
    assert.equal(
      out.content,
      '# Search results: riscv news\n\n1. **[K one](https://k.example/1)** · 2026-09-01\n\n   First.\n\n   > Snip one\n\n2. **[K two](https://k.example/2)**\n\n   Second.\n'
    );
    await assert.rejects(p('keenable').run('broke'), { status: 402, message: 'Out of credits' });
  });
});

// ---------- one prompt, many providers ----------

describe('orchestrator: research across providers', () => {
  beforeEach(setup);
  afterEach(teardown);
  const current = (id) => stateStore.getRequest(id).request;
  const outFiles = () => fs.readdirSync(isolation.outputDir).sort();

  function allProviders(extra = []) {
    return router([
      ...extra,
      ['POST https://api.tavily.com/research', () => streamRes([sse([chunk({ content: '# Tavily report' }), 'event: done\n'])])],
      ['POST https://api.exa.ai/agent/runs', () => jsonRes(200, { id: 'run_9', status: 'queued' })],
      ['GET https://api.exa.ai/agent/runs/run_9', () => jsonRes(200, { id: 'run_9', status: 'completed', output: { text: '# Exa report', grounding: [] } })],
      ['POST https://api.keenable.ai/v1/search', () => jsonRes(200, { results: [{ url: 'https://k.example/1', title: 'K1' }] })],
    ]);
  }

  it('sends one prompt to a chosen group: each provider runs, tracks and saves on its own', async () => {
    key('TAVILY_API_KEY', 'tvly-test-key-0010');
    key('EXA_API_KEY', 'exa-test-key-0010');
    key('KEENABLE_API_KEY', 'keen_test_key_00000010');
    providers.setFetch(allProviders());
    const thread = stateStore.createThread('frontier');

    const { batchId, requests } = await orchestrator.research({ threadId: thread.id, input: '  RISC-V vs ARM  ', providers: ['tavily', 'exa:xhigh', 'keenable'] });
    assert.equal(requests.length, 3);
    assert.ok(requests.every((r) => r.batchId === batchId && r.input === 'RISC-V vs ARM'));
    const [tv, ex, kn] = requests.map((r) => r.id);

    // Exa is a polled job: accepted and tracked with its run id and its own limit.
    assert.deepEqual([current(ex).provider, current(ex).mode, current(ex).status, current(ex).jobId], ['exa', 'xhigh', 'RESEARCHING', 'run_9']);
    assert.equal(current(ex).limitMs, 15 * MIN);
    assert.ok(orchestrator.timers.has(ex));
    // Keenable answers at once.
    assert.equal(current(kn).status, 'SAVED · VERIFIED');
    // The thread is busy until every provider is done.
    await assert.rejects(orchestrator.research({ threadId: thread.id, input: 'again', providers: ['keenable'] }), { status: 409 });

    await orchestrator.settle();
    assert.equal(current(tv).status, 'SAVED · VERIFIED');
    assert.equal(current(tv).content, '# Tavily report');
    await orchestrator.doPoll(ex);
    assert.equal(current(ex).status, 'SAVED · VERIFIED');
    assert.equal(current(ex).notifyPending, true);

    const files = outFiles();
    assert.equal(files.length, 3);
    assert.ok(files.some((f) => /^\d\d-\d\d:\d{4}\.\d\d-tavily\.md$/.test(f)));
    assert.ok(files.some((f) => /-exa\.md$/.test(f)));
    assert.ok(files.some((f) => /-keenable\.md$/.test(f)));
    assert.equal(fs.readFileSync(path.join(isolation.outputDir, files.find((f) => f.endsWith('-exa.md'))), 'utf8'), '# Exa report');
    assert.equal(orchestrator.inFlightCount(), 0);
  });

  it('"all" runs only providers with a key; a provider picked without one fails on its own', async () => {
    key('KEENABLE_API_KEY', 'keen_test_key_00000011');
    providers.setFetch(allProviders());
    const t1 = stateStore.createThread('frontier');
    const all = await orchestrator.research({ threadId: t1.id, input: 'q', providers: 'all' });
    assert.deepEqual(all.requests.map((r) => r.provider), ['keenable']);

    const t2 = stateStore.createThread('frontier');
    const picked = await orchestrator.research({ threadId: t2.id, input: 'q', providers: ['tinyfish', 'you', 'keenable'] });
    const [tf, yc] = picked.requests.map((r) => current(r.id));
    assert.equal(tf.status, 'FAILED');
    assert.deepEqual([tf.error.title, tf.error.message, tf.error.status], ['Submission failed', 'No TinyFish API key saved', 401]);
    assert.deepEqual([yc.status, yc.error.message, yc.error.status], ['FAILED', 'No You.com API key saved', 401]);
    assert.equal(current(picked.requests[2].id).status, 'SAVED · VERIFIED');
  });

  it('a broken stream fails that provider with the reason, not the batch', async () => {
    key('TAVILY_API_KEY', 'tvly-test-key-0012');
    key('KEENABLE_API_KEY', 'keen_test_key_00000012');
    providers.setFetch(
      allProviders([
        [
          'POST https://api.tavily.com/research',
          () => {
            const res = streamRes([sse([chunk({ content: 'Half a rep' })])]);
            const inner = res.body;
            res.body = (async function* () {
              yield* inner;
              throw new TypeError('terminated');
            })();
            return res;
          },
        ],
      ])
    );
    const thread = stateStore.createThread('frontier');
    const { requests } = await orchestrator.research({ threadId: thread.id, input: 'q', providers: ['tavily', 'keenable'] });
    await orchestrator.settle();
    const tv = current(requests[0].id);
    assert.equal(tv.status, 'FAILED');
    assert.equal(tv.error.title, 'Research failed');
    assert.equal(tv.error.message, "Tavily's stream broke off after 10 characters of the report: terminated");
    assert.equal(current(requests[1].id).status, 'SAVED · VERIFIED');
  });

  it("a key the provider echoes back mid-stream is masked in the request and the log", async () => {
    // No known key prefix, so only masking by the saved value can catch it.
    key('TAVILY_API_KEY', 'plainsecretvalue0014');
    providers.setFetch(router([['POST https://api.tavily.com/research', () => streamRes([sse([{ object: 'error', error: 'Rejected credential plainsecretvalue0014.' }])])]]));
    const thread = stateStore.createThread('frontier');
    const { requests } = await orchestrator.research({ threadId: thread.id, input: 'q', providers: ['tavily'] });
    await orchestrator.settle();
    const tv = current(requests[0].id);
    assert.equal(tv.error.message, 'Tavily reported an error: Rejected credential ***.');
    assert.ok(!JSON.stringify(stateStore.getRawState()).includes('plainsecretvalue0014'));
    assert.ok(!JSON.stringify(logger.getLogs()).includes('plainsecretvalue0014'));
  });

  it('an unexpected error after a stream marks the request failed instead of stopping the server', async () => {
    key('TAVILY_API_KEY', 'tvly-test-key-0015');
    providers.setFetch(allProviders());
    const original = settings.validateOutputDir;
    settings.validateOutputDir = () => {
      throw new Error('output folder check blew up');
    };
    try {
      const thread = stateStore.createThread('frontier');
      const { requests } = await orchestrator.research({ threadId: thread.id, input: 'q', providers: ['tavily'] });
      await orchestrator.settle();
      const tv = current(requests[0].id);
      assert.deepEqual([tv.status, tv.error.title, tv.error.message], ['FAILED', 'Research failed', 'output folder check blew up']);
    } finally {
      settings.validateOutputDir = original;
    }
  });

  it('a request gone from state by the time its stream ends is let go quietly', async () => {
    key('TAVILY_API_KEY', 'tvly-test-key-0016');
    providers.setFetch(router([['POST https://api.tavily.com/research', () => streamRes([sse([chunk({ content: '# Late' }), 'event: done\n'])], { delayMs: 20 })]]));
    const thread = stateStore.createThread('frontier');
    await orchestrator.research({ threadId: thread.id, input: 'q', providers: ['tavily'] });
    stateStore.setRawState({ threads: [], activeThreadId: null, lruOrder: [] });
    await orchestrator.settle();
    assert.deepEqual(outFiles(), []);
  });

  it('TinyFish deep is tracked to its own 20 minute limit', async () => {
    key('TINYFISH_API_KEY', 'tf-test-key-0013');
    providers.setFetch(router([['GET https://agent.tinyfish.ai/v1/research-run/*', () => jsonRes(200, { status: 'RUNNING' })]]));
    const thread = stateStore.createThread('frontier');
    const tracked = (agoMs) => {
      const r = stateStore.createRequest(thread.id, { provider: 'tinyfish', mode: 'deep', input: 'q', status: 'RESEARCHING', limitMs: 20 * MIN });
      stateStore.updateRequest(r.id, { jobId: 'rr_9', trackingActive: true, submittedAt: new Date(Date.now() - agoMs).toISOString() });
      return r.id;
    };
    const at16 = tracked(16 * MIN);
    await orchestrator.doPoll(at16);
    assert.equal(current(at16).status, 'RESEARCHING');
    assert.equal(current(at16).schedule.intervalMs, 30000);
    assert.ok(orchestrator.timers.has(at16));

    const at20 = tracked(20 * MIN + 1000);
    await orchestrator.doPoll(at20);
    assert.equal(current(at20).status, 'FAILED');
    assert.equal(current(at20).error.message, 'TinyFish still had the job running after 20 minutes, so the app stopped waiting for it.');
  });

  it('the server waits for in-flight work only until each request\'s own limit has passed', () => {
    const thread = stateStore.createThread('frontier');
    const at = (agoMs, limitMs, provider = 'tinyfish') => {
      const r = stateStore.createRequest(thread.id, { provider, mode: 'deep', input: 'q', status: 'RESEARCHING', limitMs });
      stateStore.updateRequest(r.id, { submittedAt: new Date(Date.now() - agoMs).toISOString() });
      return r;
    };
    assert.equal(orchestrator.inFlightDeadline(), 0);
    const a = at(14 * MIN, 15 * MIN, 'you');
    const b = at(5 * MIN, 20 * MIN);
    const due = (r) => Date.parse(r.submittedAt) + r.limitMs + MIN;
    assert.equal(orchestrator.inFlightDeadline(), due(b));
    stateStore.updateRequest(b.id, { status: 'SAVED · VERIFIED' });
    assert.equal(orchestrator.inFlightDeadline(), due(a));
    // A request with no time on record can't hold the server open.
    const c = at(0, 15 * MIN);
    stateStore.updateRequest(c.id, { submittedAt: null, createdAt: null });
    assert.equal(orchestrator.inFlightDeadline(), due(a));
  });

  it('refuses an empty prompt and an unknown provider before creating anything', async () => {
    const thread = stateStore.createThread('frontier');
    await assert.rejects(orchestrator.research({ threadId: thread.id, input: '   ', providers: 'all' }), { status: 400, message: 'Write a research prompt first.' });
    await assert.rejects(orchestrator.research({ threadId: thread.id, input: 'q', providers: ['nope'] }), { status: 400 });
    assert.equal(stateStore.getThread(thread.id).requests.length, 0);
  });
});
