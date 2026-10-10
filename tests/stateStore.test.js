'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { isolateDataDir } = require('./helpers');

describe('stateStore threads + restart', () => {
  let stateStore;
  let isolation;

  beforeEach(() => {
    isolation = isolateDataDir('ydc-state-');
    stateStore = require('../server/stateStore');
    stateStore.setRawState({ threads: [], activeThreadId: null, lruOrder: [] });
  });

  afterEach(() => {
    if (isolation) isolation.restore();
  });

  it('keeps 20 sidebar threads; 21st evicts oldest from list only', () => {
    const ids = [];
    for (let i = 0; i < 21; i++) {
      const t = stateStore.createThread('frontier');
      stateStore.updateThread(t.id, { title: `T${i}` });
      ids.push(t.id);
    }
    const sidebar = stateStore.listSidebarThreads();
    assert.equal(sidebar.length, 20);
    // Oldest (ids[0]) should be dropped from LRU list
    assert.equal(sidebar.find((t) => t.id === ids[0]), undefined);
    // But thread object still exists in raw state
    assert.ok(stateStore.getThread(ids[0]));
    assert.equal(stateStore.getRawState().threads.length, 21);
  });

  it('viewing or editing a thread does not reorder the sidebar; submitting does', () => {
    const a = stateStore.createThread('frontier');
    const b = stateStore.createThread('frontier');
    const order = () => stateStore.listSidebarThreads().map((t) => t.id);
    assert.deepEqual(order(), [b.id, a.id]);
    stateStore.setActive(a.id);
    stateStore.updateThread(a.id, { draft: 'typing', title: 'Renamed', mode: 'answers' });
    assert.deepEqual(order(), [b.id, a.id]);
    stateStore.createRequest(a.id, { mode: 'answers', input: 'q', status: 'SUBMITTING' });
    assert.deepEqual(order(), [a.id, b.id]);
  });

  it('drop from sidebar leaves thread data intact', () => {
    const t = stateStore.createThread('answers');
    stateStore.createRequest(t.id, { mode: 'answers', input: 'hi', status: 'DRAFT' });
    stateStore.dropFromSidebar(t.id);
    assert.equal(stateStore.listSidebarThreads().find((x) => x.id === t.id), undefined);
    assert.ok(stateStore.getThread(t.id));
    assert.equal(stateStore.getThread(t.id).requests.length, 1);
  });

  it('restart keeps tracking every job You.com accepted; requests without one fail', () => {
    const t = stateStore.createThread('frontier');
    const mk = (status, extra) => {
      const r = stateStore.createRequest(t.id, { mode: 'frontier', input: 'q', status });
      stateStore.updateRequest(r.id, { status, ...extra });
      return r.id;
    };
    const tracked = mk('RESEARCHING', { jobId: 'job-1', trackingActive: true, submittedAt: new Date().toISOString() });
    const legacy = mk('TRACKING PAUSED', { jobId: 'job-2', trackingActive: false, submittedAt: new Date().toISOString() });
    const noJob = mk('SUBMITTING', {});
    stateStore.persistNow();

    stateStore.load();
    const r = (id) => stateStore.getRequest(id).request;
    for (const id of [tracked, legacy]) {
      assert.equal(r(id).status, 'RESEARCHING');
      assert.equal(r(id).trackingActive, true);
    }
    assert.equal(r(legacy).jobId, 'job-2');
    assert.equal(r(noJob).status, 'FAILED');
    assert.equal(r(noJob).error.message, 'The app stopped before the result came in, so this request was lost.');
  });

  describe('thread titles', () => {
    const AGENTGATEWAY_PROMPT = 'Deeply research the **current stable Agentgateway release** so you can produce an accurate, step-by-step implementation manual for putting my existing self-hosted MCP servers behind Agentgateway with OAuth/OIDC.\n\nI currently run Agentgateway v1.6.0 in Docker Compose.\n\n## PRIMARY DELIVERABLE\n\n**80% of your final response must be a practical implementation manual.**\n\nThe research is supporting work. Its purpose is to determine the correct configuration.\n\nThe deliverable should detail, step by step, how to configure the different OAuth/OIDC methods Agentgateway actually supports for MCP.\n\nFor every supported method, provide:\n\n1. What the method does.\n2. What external OAuth/OIDC provider, if any, it requires.\n3. What must be configured at that provider.\n4. The exact Agentgateway YAML required.\n5. How to configure the MCP backend.\n\nDo not merely describe capabilities. **Turn every relevant capability into configuration instructions.**\n\n## Existing environment\n\nAlready working:\n\n- Agentgateway\n- Docker Compose\n- Caddy\n- PostgreSQL request logging\n- Axiom OTLP logging\n- LLM routing\n- several self-hosted MCP servers\n\nTarget architecture:\n\n```\nMCP client\n    |\n  Caddy\n    |\nAgentgateway\n    |\nexisting MCP server\n```\n\nThe MCP backend may itself support only an API key. Investigate whether Agentgateway can authenticate users with OAuth externally while authenticating separately to that backend.\n\n# Research required to build the manual\n\nDetermine exactly what Agentgateway supports for MCP OAuth/OIDC.\n\nSpecifically investigate whether Agentgateway can act as:\n\n- OAuth Resource Server\n- OAuth Authorization Server\n- OAuth Client\n- OIDC Relying Party\n- MCP Protected Resource\n- token validator\n- OAuth metadata proxy\n- Dynamic Client Registration proxy/adapter\n- token-exchange client\n- identity/token propagation layer\n\nDetermine whether Agentgateway:\n\n- issues authorization codes or access tokens itself\n- requires an external authorization server\n- validates JWTs\n- supports opaque tokens\n- supports token introspection\n- supports JWKS discovery\n- supports OIDC discovery\n- exposes RFC 9728 Protected Resource Metadata\n- handles or proxies OAuth metadata\n- handles or proxies Dynamic Client Registration\n- can adapt an ordinary OAuth/OIDC provider for MCP use\n- can accept OAuth from the MCP client while using an API key or separate credential toward the MCP backend\n- can propagate identity or exchange tokens toward the backend\n\nFor every feature that exists, the important question is:\n\n> **How do I configure it?**\n\nSpend very little time explaining concepts unless necessary to understand a configuration decision.\n\n# OAuth provider research\n\nIf Agentgateway requires an external authorization server, research practical options including:\n\n- Auth0\n- GitHub\n- Keycloak\n- authentik\n- Okta\n- Descope\n- WorkOS\n- generic standards-compliant OAuth/OIDC providers\n\nPrioritize providers that are FREE.\n\nFor each viable provider, tell me only:\n\n- whether it works with Agentgateway\'s MCP OAuth design\n- which OAuth capabilities it provides that Agentgateway needs\n- what I must configure there\n- any important limitations\n- the Agentgateway settings required to use it\n\nThen recommend the simplest options.\n\n# Dynamic Client Registration\n\nResearch Agentgateway\'s DCR behavior specifically:\n\n- Does Agentgateway implement DCR?\n- Proxy it?\n- Adapt it?\n- Require the upstream identity provider to support it?\n- Can static/pre-registered clients be used instead?\n\n# MCP authorization\n\nShow how to configure Agentgateway authorization for cases such as:\n\n```\nRead-only identity:\n  read/search/list tools only\n```\n\nDetermine whether unauthorized tools can be removed from `tools/list` or whether calls are only rejected later.\n\nShow the actual supported configuration.\n\n# MCP backend configuration\n\nShow how to proxy an existing MCP such as:\n\n```\nhttp://internal-mcp:PORT/mcp\n```\n\nthrough Agentgateway.\n\nProvide verified YAML for:\n\n- MCP backend\n- gateway/route\n- OAuth authentication\n- JWT/token validation\n- authorization\n- required MCP metadata\n- backend authentication where relevant\n\n**The final deliverable MUST be a full and complete setup guide and implementation walkthrough in detail, step by step for configuring oauth for an MCP in agentgateway.**\n\n# Sources and accuracy\n\nPrefer:\n\n1. current official Agentgateway documentation\n2. Agentgateway source/schema\n3. official MCP specification\n4. OAuth/OIDC RFCs\n5. official identity-provider documentation\n6. relevant GitHub issues/source when necessary\n\nI want a **deeply researched implementation manual**, not a conceptual OAuth report and NOT a security mating manual. ';
    const TECH_AGENT_PROMPT = 'You are a technical research agent. Your task: find, verify, and document a specific integration — an MCP-based bridge between the GitHub Copilot CLI and Microsoft Copilot Studio agents.\n\n## The claim to verify\nA connector exists (built either by Microsoft or by a community developer) that works as follows:\n- It is an MCP (Model Context Protocol) connector/server.\n- It sits between the GitHub Copilot CLI and a Microsoft Copilot Studio agent.\n- The Copilot CLI\'s chat completions API calls are converted into MCP format.\n- The Copilot Studio agent sends and receives everything through MCP — it operates the Copilot CLI fully and natively, the same as any other agent, except the transport is MCP rather than direct API calls. Functionally identical behavior.\n- The bridge itself involves no separate model — it is a protocol conversion layer, not a new model.\n\n## How to research — source priority matters\nWork in this order. Microsoft\'s official docs are confusing and abstract; real implementations teach more than documentation.\n\n1. **Real-world usage first.** Reddit (r/AZURE, r/copilot, r/MicrosoftCopilot, r/mcp, r/github), dev.to, Stack Overflow, YouTube walkthroughs, blog posts, X/Threads. Find threads where people describe ACTUALLY doing this — not announcing it, doing it. Quote what they did and link the thread. A Reddit comment with exact commands that worked outranks a docs page describing the feature.\n2. **How Azure supports it.** Figure out the Azure-native side of the MCP layer and how people actually host/run it in Azure: the open-source Azure MCP Server, Azure API Management exposing APIs as MCP servers, the Azure Functions MCP extension, Azure AI Foundry\'s MCP support. Determine which Azure piece people really use to host or expose this bridge — then build outward from there.\n3. **Code.** GitHub repos (Microsoft orgs and community), npm/PyPI packages wrapping the Copilot CLI as an MCP server. Note stars, last commit date, and what the README actually claims.\n4. **Microsoft docs LAST.** Use Learn docs only to confirm or clarify what the real-world sources describe — never as the primary source of "how to do it." If docs and real-world practice conflict, report the conflict and go with what actually works.\n\n## Verification rules (strict)\n- For every factual claim, cite the exact source URL and quote or summarize what the source actually says. Never infer that an endpoint, repo, or feature exists — link it, or say it could not be found.\n- Establish authorship clearly: Microsoft-official vs. community-built. Name the author/org.\n- Establish the direction of the bridge: the target is the Copilot Studio agent driving the CLI through MCP (CLI\'s chat completions converted to MCP format) — not the reverse.\n- Distinguish the target from adjacent but different things, and label each candidate explicitly:\n  a. Copilot CLI\'s built-in MCP *client* support (the CLI calling external MCP servers) — NOT the target.\n  b. Copilot Studio\'s generic MCP connector for calling third-party MCP servers — relevant only if someone used\n\n## Deliverable\n1. **Verdict**: does the described bridge exist? One paragraph, with the single best source link (prefer the real-world source, not the docs page).\n2. **What it is**: author, repo/thread/docs links, and the architecture in plain terms — what runs where, what the MCP transport carries, and which Azure service hosts the MCP layer.\n3. **Exact setup instructions the way people actually do it**, step by step, with every command and every config file included verbatim:\n   - The Azure piece: which service hosts the MCP layer, how to deploy/configure it, exact commands or portal steps.\n   - Installation commands (npm/pip/etc.) exactly as used in the real-world sources.\n   - Configuration: every config file, its path, and its full contents.\n   - Copilot Studio side: exactly where to click / what to add (connector name as it appears in the product) to register the MCP server.\n\nDO NOT ASSUME THIS DOES NOT EXIST BECAUSE YOUR BASELINE KNOWLEDGE SUGGESTS NOT. BE FACTUAL NOT BIASED. ';
    const LONG_TOKEN = 'Q' + 'x'.repeat(79);
    const TRAILING_FILLER = new Set(
      'a an the of to for in on at by with from about into and or but so that which who as is are was were be can could will would should you your my our i we it its this these those than then via vs if e.g i.e eg ie etc'.split(' ')
    );
    const CASES = [
      [AGENTGATEWAY_PROMPT, 'Current stable Agentgateway release'],
      [TECH_AGENT_PROMPT, 'Technical research agent'],
      ['what is RISC-V?', 'RISC-V'],
      ['Compare RISC-V and ARM architectures focusing on licensing and extensibility', 'Compare RISC-V and ARM architectures'],
      ['Please explain how TLS 1.3 handshakes work', 'TLS 1.3 handshakes work'],
      ['Can you help me?', 'Can you help me'],
      ['# Kubernetes networking deep dive\n\nmore text', 'Kubernetes networking deep dive'],
      ['https://docs.example.com/a/b https://x.org/c', 'docs.example.com +1'],
      ['', 'Untitled'],
      ['   ', 'Untitled'],
      [LONG_TOKEN, LONG_TOKEN.slice(0, 59) + '…'],
      ['Postgres vs. MySQL for analytics workloads', 'Postgres vs. MySQL for analytics'],
      ['Explain e.g. how CRDTs work', 'CRDTs work'],
      ['**Goal:** figure out why my Docker containers lose DNS', 'Docker containers lose DNS'],
      ['Task: compare Bun and Deno for CLI tools', 'Compare Bun and Deno'],
      ['Investigate whether the M5 MacBook Pro supports three external displays', 'M5 MacBook Pro supports three'],
      ['Tell me everything about the history of the Roman Empire', 'History of the Roman Empire'],
      ['First Amendment limits on platform moderation', 'First Amendment limits on platform'],
      ['Research: latest Claude model pricing', 'Latest Claude model pricing'],
      ['Can you', 'Can you'],
    ];
    // All-filler prompts have no descriptive word, so their title keeps the opening words as written.
    const ALL_FILLER = new Set(['Can you help me?', 'Can you']);

    it('derives a short whole-word title from the first descriptive word', () => {
      for (const [input, expected] of CASES) {
        assert.equal(stateStore.titleFromPrompt(input), expected, JSON.stringify(input.slice(0, 40)));
      }
    });

    it('never ends in a filler word and never exceeds 60 characters', () => {
      for (const [input] of CASES) {
        const title = stateStore.titleFromPrompt(input);
        const last = title.split(' ').pop().toLowerCase();
        if (!ALL_FILLER.has(input)) assert.ok(!TRAILING_FILLER.has(last), title);
        assert.ok(title.length <= 60, title);
      }
    });

    it('re-titles auto-titled threads on load and leaves other titles alone', () => {
      const mk = (id, title, input) => ({
        id,
        title,
        mode: 'frontier',
        requests: input === null ? [] : [{ id: id + '-r', input, status: 'RECEIVED' }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const legacyA = AGENTGATEWAY_PROMPT.replace(/\s+/g, ' ').trim().slice(0, 45) + '…';
      stateStore.setRawState({
        threads: [
          mk('a', legacyA, AGENTGATEWAY_PROMPT),
          mk('b', 'My own name', AGENTGATEWAY_PROMPT),
          mk('c', 'New Thread', null),
        ],
        activeThreadId: null,
        lruOrder: ['a', 'b', 'c'],
      });
      stateStore.persistNow();

      stateStore.load();
      const titles = () => Object.fromEntries(stateStore.getRawState().threads.map((t) => [t.id, t.title]));
      assert.deepEqual(titles(), { a: 'Current stable Agentgateway release', b: 'My own name', c: 'New Thread' });
      const onDisk = JSON.parse(fs.readFileSync(stateStore.STATE_PATH, 'utf8'));
      assert.equal(onDisk.threads.find((t) => t.id === 'a').title, 'Current stable Agentgateway release');

      stateStore.load();
      assert.deepEqual(titles(), { a: 'Current stable Agentgateway release', b: 'My own name', c: 'New Thread' });
    });

    it('titles a new thread from its first request', () => {
      const t = stateStore.createThread('frontier');
      stateStore.createRequest(t.id, { input: AGENTGATEWAY_PROMPT });
      assert.equal(stateStore.getThread(t.id).title, 'Current stable Agentgateway release');
    });

    it('titles a Contents thread from its URLs', () => {
      const t = stateStore.createThread('contents');
      stateStore.createRequest(t.id, { mode: 'contents', input: '', urls: ['https://docs.example.com/a', 'https://x.org/b'] });
      assert.equal(stateStore.getThread(t.id).title, 'docs.example.com +1');
    });

    it('titles from the prose around a code block, not the code', () => {
      assert.equal(stateStore.titleFromPrompt('```js\nconst x = [].reduce((a, b) => a + b);\n```\nWhy does reduce return NaN here?'), 'Reduce return NaN here');
      assert.equal(stateStore.titleFromPrompt('```\nOnly code here\n```'), 'Only code here');
    });
  });
});
