'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const youClient = require('../server/youClient');
const envKey = require('../server/envKey');

describe('youClient request construction', () => {
  afterEach(() => {
    youClient.resetFetch();
  });

  it('builds research body with background true for frontier and exhaustive', () => {
    const f = youClient.buildResearchBody('hello', 'frontier');
    assert.deepEqual(f, { input: 'hello', research_effort: 'frontier', background: true });
    const e = youClient.buildResearchBody('deep', 'exhaustive');
    assert.deepEqual(e, { input: 'deep', research_effort: 'exhaustive', background: true });
  });

  it('builds answers body and enforces 400 char max', () => {
    assert.deepEqual(youClient.buildAnswersBody('q'), { query: 'q' });
    assert.throws(() => youClient.buildAnswersBody('x'.repeat(401)), /400/);
  });

  it('builds contents body with markdown format', () => {
    const b = youClient.buildContentsBody(['https://a.com', 'https://b.com']);
    assert.deepEqual(b, { urls: ['https://a.com', 'https://b.com'], formats: ['markdown'] });
  });
});
