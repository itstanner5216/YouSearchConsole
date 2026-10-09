'use strict';

/**
 * Research providers. Each is one research call with at most two depth levels (the
 * provider's own knob); everything else is fixed here so choosing a provider stays simple.
 *
 * kind:
 *   poll   — start returns a job id; the orchestrator checks it on the poller schedule,
 *            so tracking survives a restart (You.com, Exa, TinyFish)
 *   stream — one long request whose report streams in; done when the stream ends (Tavily, Jina)
 *   once   — one quick request (Keenable search)
 *
 * Levels list the default first. limitMs is how long a run may take before it counts as
 * not coming: 15 minutes, except where the provider documents longer.
 */

const envKey = require('./envKey');
const youClient = require('./youClient');
const saver = require('./saver');
const poller = require('./poller');
const { redact } = require('./logger');

const MIN = 60 * 1000;
const LIMIT = poller.FAILSAFE_MS;
// Start and status calls answer in seconds; a stream must keep sending (both stream every few seconds).
const CALL_TIMEOUT_MS = 60 * 1000;
const STREAM_IDLE_MS = 8 * MIN;

/** Injectable fetch for tests (You.com calls go through youClient's own). */
let fetchImpl = globalThis.fetch.bind(globalThis);
function setFetch(fn) {
  fetchImpl = fn;
}
function resetFetch() {
  fetchImpl = globalThis.fetch.bind(globalThis);
}

// ---------- shared plumbing ----------

function keyFor(p) {
  const key = envKey.getKey(p.keyName);
  if (!key) throw Object.assign(new Error(`No ${p.name} API key saved`), { code: 'NO_API_KEY', status: 401 });
  return key;
}

// The provider's own error text; a key echoed back in it is masked.
async function httpError(p, res, key) {
  let body = '';
  try {
    body = await res.text();
  } catch (_) {
    body = '';
  }
  let message = body;
  try {
    const j = JSON.parse(body);
    // Tavily {detail:{error}}, Exa/TinyFish {error:{message}}, others {message}/{error}/{detail}.
    const text = (v) =>
      typeof v === 'string' ? v : v && typeof v.message === 'string' ? v.message : v && typeof v.error === 'string' ? v.error : '';
    message = text(j.error) || text(j.detail) || text(j.message) || body;
  } catch (_) {
    /* not JSON: keep the text */
  }
  const scrub = (s) => redact(key ? String(s).split(key).join('***') : String(s));
  const err = new Error(scrub(message || res.statusText || `HTTP ${res.status}`));
  err.status = res.status;
  err.body = scrub(body);
  return err;
}

/** One JSON call with a timeout. Returns the parsed body. */
async function call(p, url, { method = 'GET', body, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  const key = keyFor(p);
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { ...p.auth(key), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw networkError(p, err, `${p.name} didn't answer within ${span(timeoutMs)}`);
  }
  if (!res.ok) throw await httpError(p, res, key);
  return res.json();
}

function networkError(p, err, timeoutText) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return new Error(timeoutText);
  const cause = err && err.cause && err.cause.message ? ` (${err.cause.message})` : '';
  return new Error(`Couldn't reach ${p.name}: ${(err && err.message) || err}${cause}`);
}

function span(ms) {
  if (ms < MIN) return `${Math.round(ms / 1000)}s`;
  const m = Math.round(ms / MIN);
  return m === 1 ? '1 minute' : `${m} minutes`;
}

/**
 * Timers for one streamed run: the whole run is capped at its limit, and the stream must
 * keep sending. Aborting the signal ends the fetch and its body.
 */
function streamGuard(totalMs, idleMs = STREAM_IDLE_MS, openMs = CALL_TIMEOUT_MS) {
  const ac = new AbortController();
  let why = null;
  const stop = (reason) => {
    if (!why) why = reason;
    ac.abort();
  };
  const total = setTimeout(() => stop(`ran past ${span(totalMs)}`), totalMs);
  // Until the provider answers with its stream, the first wait is a normal call's.
  let idle = setTimeout(() => stop(`didn't answer within ${span(openMs)}`), openMs);
  const unref = (t) => (t && typeof t.unref === 'function' ? t.unref() : t);
  unref(total);
  unref(idle);
  return {
    signal: ac.signal,
    alive() {
      clearTimeout(idle);
      idle = unref(setTimeout(() => stop(`sent nothing for ${span(idleMs)}`), idleMs));
    },
    done() {
      clearTimeout(total);
      clearTimeout(idle);
    },
    reason: () => why,
  };
}

/** Opens a streamed POST; resolves once the provider has accepted it (headers in). */
async function openStream(p, url, body, guard) {
  const key = keyFor(p);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { ...p.auth(key), Accept: 'text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: guard.signal,
    });
  } catch (err) {
    throw networkError(p, err, `${p.name} ${guard.reason() || "didn't answer"}`);
  }
  guard.alive();
  if (!res.ok) throw await httpError(p, res, key);
  return res;
}

/** Yields each SSE `data:` payload. Lines are buffered across network chunks, so none is cut in half. */
async function* sseData(res, guard) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    guard.alive();
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  buf += decoder.decode();
  if (buf.startsWith('data:')) yield buf.slice(5).trim();
}

function parseJson(text) {
  if (!text || text === '[DONE]') return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/** Collects sources as {url, title}, first title wins, order kept. */
function sourceList() {
  const list = [];
  const seen = new Map();
  return {
    add(url, title) {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
      if (seen.has(url)) {
        const s = seen.get(url);
        if (!s.title && title) s.title = String(title);
        return;
      }
      const s = { url, title: title ? String(title) : '' };
      seen.set(url, s);
      list.push(s);
    },
    list,
  };
}

/**
 * The saved report stands on its own: when the provider returns its sources separately and
 * the text doesn't already link them all, they are listed at the end.
 */
function withSources(text, sources) {
  const body = String(text || '').trim();
  if (!body || !sources.length || sources.every((s) => body.includes(s.url))) return body;
  const lines = sources.map((s, i) => `${i + 1}. [${(s.title || s.url).replace(/[[\]]/g, '')}](${s.url})`);
  return `${body}\n\n## Sources\n\n${lines.join('\n')}\n`;
}

// An error the provider itself sent inside the stream, as opposed to the stream breaking.
function reported(message) {
  return Object.assign(new Error(message), { reported: true });
}

function streamFailure(p, err, guard, got) {
  if (err && err.reported) return new Error(`${p.name} reported an error: ${err.message}`);
  const why = guard.reason();
  const partial = got ? ` after ${got.toLocaleString('en-US')} characters of the report` : '';
  if (why) return new Error(`${p.name}'s stream ${why}${partial}.`);
  if (err && err.status) return err;
  return new Error(`${p.name}'s stream broke off${partial}: ${(err && err.message) || err}`);
}

// ---------- providers ----------

const you = {
  id: 'you',
  name: 'You.com',
  keyName: envKey.KEY_NAME,
  kind: 'poll',
  levels: [
    { id: 'frontier', label: 'Frontier', limitMs: LIMIT },
    { id: 'exhaustive', label: 'Exhaustive', limitMs: LIMIT },
  ],
  async start(input, level) {
    const data = await youClient.submitResearch(input, level);
    return { jobId: data.task_id, raw: data, extra: { streamUrl: data.stream_url || null } };
  },
  async check(jobId) {
    const data = await youClient.pollResearch(jobId);
    const status = String(data.status || '').toLowerCase();
    if (status === 'queued' || status === 'running') return { state: status, raw: data };
    if (status === 'completed') {
      return {
        state: 'completed',
        raw: data,
        content: saver.extractResearchMarkdown(data),
        sources: data.result?.output?.sources || data.output?.sources || null,
      };
    }
    if (status === 'failed' || status === 'cancelled') {
      return {
        state: 'failed',
        raw: data,
        title: status === 'cancelled' ? 'Research cancelled' : 'Research failed',
        message: plainText(data.error) || plainText(data.message) || (data.error ? JSON.stringify(data.error) : `Task ${status}`),
      };
    }
    return { state: 'unknown', status, raw: data };
  },
};

const tavily = {
  id: 'tavily',
  name: 'Tavily',
  keyName: 'TAVILY_API_KEY',
  kind: 'stream',
  levels: [
    { id: 'pro', label: 'Pro', limitMs: LIMIT },
    { id: 'mini', label: 'Mini', limitMs: LIMIT },
  ],
  auth: (key) => ({ Authorization: `Bearer ${key}` }),
  // The same request Tavily's SDK sends for research(stream=True).
  body: (input, level) => ({ input, model: level, stream: true, citation_format: 'numbered' }),
  open(input, level, guard) {
    return openStream(this, 'https://api.tavily.com/research', this.body(input, level), guard);
  },
  async collect(res, guard) {
    let report = '';
    const sources = sourceList();
    try {
      for await (const text of sseData(res, guard)) {
        const ev = parseJson(text);
        if (!ev) continue;
        if (ev.error || ev.detail) throw reported(plainText(ev.error) || plainText(ev.detail) || JSON.stringify(ev.error || ev.detail));
        const delta = (ev.choices && ev.choices[0] && ev.choices[0].delta) || {};
        if (typeof delta.content === 'string') report += delta.content;
        else if (delta.content && typeof delta.content === 'object') report += JSON.stringify(delta.content, null, 2);
        // The closing sources event lists everything used; tool responses list what each search found.
        for (const s of delta.sources || []) sources.add(s && s.url, s && s.title);
        const tc = delta.tool_calls;
        if (tc && tc.type === 'tool_response') {
          for (const item of tc.tool_response || []) for (const s of (item && item.sources) || []) sources.add(s && s.url, s && s.title);
        }
      }
    } catch (err) {
      throw streamFailure(this, err, guard, report.length);
    }
    if (!report.trim()) throw new Error("Tavily's stream ended without a report.");
    return { content: withSources(report, sources.list), sources: sources.list };
  },
};

const jina = {
  id: 'jina',
  name: 'Jina',
  keyName: 'JINA_API_KEY',
  kind: 'stream',
  levels: [
    { id: 'high', label: 'High', limitMs: LIMIT },
    { id: 'medium', label: 'Medium', limitMs: LIMIT },
  ],
  auth: (key) => ({ Authorization: `Bearer ${key}` }),
  // Streaming is required: unstreamed, DeepSearch can come back with empty content, and long runs time out.
  body: (input, level) => ({
    model: 'jina-deepsearch-v1',
    messages: [{ role: 'user', content: input }],
    stream: true,
    reasoning_effort: level,
    max_returned_urls: 20,
  }),
  open(input, level, guard) {
    return openStream(this, 'https://deepsearch.jina.ai/v1/chat/completions', this.body(input, level), guard);
  },
  async collect(res, guard) {
    let text = '';
    const cited = sourceList();
    let read = [];
    let visited = [];
    try {
      for await (const data of sseData(res, guard)) {
        const ev = parseJson(data);
        if (!ev) continue;
        const choice = (ev.choices && ev.choices[0]) || {};
        const delta = choice.delta || choice.message || {};
        if (delta.type === 'error' || choice.finish_reason === 'error') {
          throw reported(typeof delta.content === 'string' && delta.content.trim() ? delta.content.trim() : 'no details given');
        }
        if (typeof delta.content === 'string') text += delta.content;
        for (const a of delta.annotations || []) if (a && a.url_citation) cited.add(a.url_citation.url, a.url_citation.title);
        if (Array.isArray(ev.readURLs) && ev.readURLs.length) read = ev.readURLs;
        if (Array.isArray(ev.visitedURLs) && ev.visitedURLs.length) visited = ev.visitedURLs;
      }
    } catch (err) {
      throw streamFailure(this, err, guard, answerOf(text).length);
    }
    // DeepSearch thinks out loud inside <think>…</think>; the report is what follows.
    const answer = answerOf(text);
    if (!answer) throw new Error("Jina's stream ended before DeepSearch gave its answer.");
    for (const u of [...read, ...visited]) cited.add(u);
    const sources = cited.list.slice(0, 20);
    return { content: withSources(answer, sources), sources };
  },
};

function answerOf(text) {
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/, '') // still thinking when the stream stopped
    .trim();
}

const exa = {
  id: 'exa',
  name: 'Exa',
  keyName: 'EXA_API_KEY',
  kind: 'poll',
  // Fixed-price efforts ($0.50 / $1 a run); auto and ultra are metered and can run for hours.
  levels: [
    { id: 'high', label: 'High', limitMs: LIMIT },
    { id: 'xhigh', label: 'Extra high', limitMs: LIMIT },
  ],
  auth: (key) => ({ 'x-api-key': key }),
  async start(input, level) {
    const data = await call(this, 'https://api.exa.ai/agent/runs', { method: 'POST', body: { query: input, effort: level } });
    if (!data || !data.id) throw new Error(`Exa accepted the run but returned no run id: ${JSON.stringify(data).slice(0, 300)}`);
    return { jobId: data.id, raw: data };
  },
  async check(jobId) {
    const data = await call(this, `https://api.exa.ai/agent/runs/${encodeURIComponent(jobId)}`);
    const status = String(data.status || '').toLowerCase();
    if (status === 'queued' || status === 'running') return { state: status, raw: data };
    if (status === 'completed') {
      const sources = sourceList();
      for (const g of data.output?.grounding || []) for (const c of g.citations || []) sources.add(c.url, c.title);
      if (!String(data.output?.text || '').trim()) {
        return { state: 'failed', raw: data, title: 'Research failed', message: 'Exa finished the run but returned no report.' };
      }
      return {
        state: 'completed',
        raw: data,
        content: withSources(data.output?.text || '', sources.list),
        sources: sources.list,
      };
    }
    if (status === 'failed' || status === 'cancelled') {
      return {
        state: 'failed',
        raw: data,
        title: status === 'cancelled' ? 'Research cancelled' : 'Research failed',
        message: plainText(data.error) || `Exa ended the run (${status}, stop reason: ${data.stopReason || 'none given'}).`,
      };
    }
    return { state: 'unknown', status, raw: data };
  },
};

const tinyfish = {
  id: 'tinyfish',
  name: 'TinyFish',
  keyName: 'TINYFISH_API_KEY',
  kind: 'poll',
  // Deep is documented at 5–20 minutes; max (up to 45) is left out.
  levels: [
    { id: 'deep', label: 'Deep', limitMs: 20 * MIN },
    { id: 'standard', label: 'Standard', limitMs: LIMIT },
  ],
  auth: (key) => ({ 'X-API-Key': key }),
  async start(input, level) {
    const query = String(input);
    if (query.length > 2000) {
      throw Object.assign(new Error(`TinyFish takes prompts up to 2,000 characters; this one is ${query.length.toLocaleString('en-US')}.`), { status: 400 });
    }
    // Never retried: TinyFish's async start isn't idempotent, so a retry could start a second paid run.
    const data = await call(this, 'https://agent.tinyfish.ai/v1/automation/run-research-async', {
      method: 'POST',
      body: { query, mode: level },
    });
    if (data && data.error) throw new Error(plainText(data.error) || JSON.stringify(data.error));
    if (!data || !data.research_run_id) throw new Error(`TinyFish returned no research run id: ${JSON.stringify(data).slice(0, 300)}`);
    return { jobId: data.research_run_id, raw: data };
  },
  async check(jobId) {
    const data = await call(this, `https://agent.tinyfish.ai/v1/research-run/${encodeURIComponent(jobId)}`);
    const status = String(data.status || '').toUpperCase();
    if (status === 'QUEUED') return { state: 'queued', raw: data };
    if (status === 'RUNNING') return { state: 'running', raw: data };
    if (status === 'COMPLETED') {
      // Deep reports live in deep_result.result, standard answers in quick_result.answer.
      const deep = data.deep_result && typeof data.deep_result.result === 'string' ? data.deep_result : null;
      const quick = data.quick_result && typeof data.quick_result.answer === 'string' ? data.quick_result : null;
      const text = deep ? deep.result : quick ? quick.answer : '';
      if (!text.trim()) {
        return { state: 'failed', raw: data, title: 'Research failed', message: 'TinyFish finished the run but returned no report.' };
      }
      const sources = sourceList();
      for (const c of (deep || quick || {}).citations || []) {
        if (typeof c === 'string') sources.add(c);
        else if (c) sources.add(c.url, c.title);
      }
      return { state: 'completed', raw: data, content: withSources(text, sources.list), sources: sources.list };
    }
    if (status === 'FAILED' || status === 'CANCELLED' || status === 'TIMED_OUT') {
      const title = { FAILED: 'Research failed', CANCELLED: 'Research cancelled', TIMED_OUT: 'Research timed out' }[status];
      const detail = data.error ? [data.error.code, plainText(data.error)].filter(Boolean).join(': ') : '';
      return { state: 'failed', raw: data, title, message: detail || `TinyFish ended the run as ${status}.` };
    }
    return { state: 'unknown', status: status.toLowerCase(), raw: data };
  },
};

const keenable = {
  id: 'keenable',
  name: 'Keenable',
  keyName: 'KEENABLE_API_KEY',
  kind: 'once',
  // Keenable has no research API: this is its search, saved as a list of results.
  levels: [{ id: 'search', label: 'Search', limitMs: LIMIT }],
  auth: (key) => ({ 'X-API-Key': key }),
  async run(input) {
    const data = await call(this, 'https://api.keenable.ai/v1/search', {
      method: 'POST',
      body: { query: input, mode: 'pro', max_results: 20 },
    });
    const results = Array.isArray(data && data.results) ? data.results : [];
    if (!results.length) throw new Error('Keenable found no results for this query.');
    const sources = sourceList();
    const items = results.map((r, i) => {
      sources.add(r.url, r.title);
      const when = r.published_at ? ` · ${String(r.published_at).slice(0, 10)}` : '';
      const lines = [`${i + 1}. **[${String(r.title || r.url).replace(/[[\]]/g, '')}](${r.url})**${when}`];
      if (r.description) lines.push(`   ${String(r.description).trim()}`);
      if (r.snippet && r.snippet !== r.description) lines.push(`   > ${String(r.snippet).replace(/\s+/g, ' ').trim()}`);
      return lines.join('\n\n');
    });
    const heading = String(input).replace(/\s+/g, ' ').trim();
    const content = `# Search results: ${heading.length > 120 ? heading.slice(0, 119) + '…' : heading}\n\n${items.join('\n\n')}\n`;
    return { content, sources: sources.list, raw: data };
  },
};

// An API field is shown only when it is plain text (or carries a text message), never as "[object Object]".
function plainText(v) {
  return typeof v === 'string' ? v : v && typeof v.message === 'string' ? v.message : v && typeof v.error === 'string' ? v.error : '';
}

// ---------- registry ----------

const PROVIDERS = [you, tavily, exa, tinyfish, jina, keenable];
const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

// The longest any run may take; the server waits at most this long for runs after the window closes.
const MAX_LIMIT_MS = Math.max(...PROVIDERS.flatMap((p) => p.levels.map((l) => l.limitMs)));

// Requests saved before providers existed have no provider: they are You.com's.
function get(id) {
  return BY_ID.get(id == null ? 'you' : String(id)) || null;
}

function levelOf(p, levelId) {
  return p.levels.find((l) => l.id === levelId) || null;
}

/** What the page needs to offer the providers: names, levels, key presence. Never the keys. */
function list() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    levels: p.levels.map((l) => ({ id: l.id, label: l.label, limitMinutes: l.limitMs / MIN })),
    defaultLevel: p.levels[0].id,
    key: envKey.presence(p.keyName),
  }));
}

/**
 * Turns a selection into concrete runs.
 *   'all' (or nothing)                → every provider with a saved key, at its default level
 *   ['tavily', 'exa:xhigh', {provider: 'you', level: 'exhaustive'}] → exactly those
 * A provider picked by name runs even without a key, and fails with "No … API key saved".
 */
function resolveSelection(selection) {
  const bad = (message) => Object.assign(new Error(message), { status: 400 });
  if (selection == null || selection === 'all') {
    const keyed = PROVIDERS.filter((p) => envKey.hasKey(p.keyName));
    if (!keyed.length) throw bad('No provider has an API key saved.');
    return keyed.map((p) => ({ provider: p, level: p.levels[0] }));
  }
  const items = Array.isArray(selection) ? selection : [selection];
  if (!items.length) throw bad('Choose at least one provider.');
  const picks = [];
  const seen = new Set();
  for (const item of items) {
    let id;
    let levelId;
    if (typeof item === 'string') [id, levelId] = item.split(':');
    else if (item && typeof item === 'object') {
      id = item.provider || item.id;
      levelId = item.level;
    }
    const p = get(String(id || '').trim().toLowerCase());
    if (!p) throw bad(`Unknown provider "${id}". Choices: ${PROVIDERS.map((x) => x.id).join(', ')}.`);
    const level = levelId ? levelOf(p, String(levelId).trim().toLowerCase()) : p.levels[0];
    if (!level) throw bad(`${p.name} has no "${levelId}" option. Choices: ${p.levels.map((l) => l.id).join(', ')}.`);
    const k = `${p.id}:${level.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    picks.push({ provider: p, level });
  }
  return picks;
}

module.exports = {
  MAX_LIMIT_MS,
  get,
  levelOf,
  list,
  resolveSelection,
  streamGuard,
  setFetch,
  resetFetch,
};
