'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const saver = require('../server/saver');

describe('saver', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ydc-save-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preserves markdown byte-for-byte', () => {
    const md = '# Title\n\nCafé ☕\n\n```js\nconst x = "a\\nb";\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';
    const r = saver.atomicWrite(dir, md);
    assert.equal(r.ok, true);
    const read = fs.readFileSync(r.path, 'utf8');
    assert.equal(read, md);
    assert.equal(Buffer.from(read, 'utf8').equals(Buffer.from(md, 'utf8')), true);
  });

  it('atomic write verifies final exists', () => {
    const r = saver.atomicWrite(dir, 'hello');
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(r.path));
    assert.ok(r.filename.endsWith('.md'));
  });

  it('timestamp filenames and -01/-02 suffixes', () => {
    const when = new Date(2026, 8, 28, 19, 47, 34); // local Sep 28 19:47:34
    assert.equal(saver.makeFilename(when), '09-28:1947.34.md');
    assert.equal(saver.makeFilename(when, 1), '09-28:1947.34-01.md');
    assert.equal(saver.makeFilename(when, 2), '09-28:1947.34-02.md');

    const r1 = saver.atomicWrite(dir, 'page1', { when, pageIndex: 1 });
    const r2 = saver.atomicWrite(dir, 'page2', { when, pageIndex: 2 });
    assert.equal(r1.filename, '09-28:1947.34-01.md');
    assert.equal(r2.filename, '09-28:1947.34-02.md');
    assert.equal(fs.readFileSync(r1.path, 'utf8'), 'page1');
    assert.equal(fs.readFileSync(r2.path, 'utf8'), 'page2');
  });

  it('extracts research / answers / contents content faithfully', () => {
    const research = {
      result: { output: { content: '## Hello\n\nWorld', content_type: 'text', sources: [] } },
    };
    assert.equal(saver.extractResearchMarkdown(research), '## Hello\n\nWorld');

    const answers = { answer: 'The answer is 42', citations: [{ source: 'x' }] };
    assert.equal(saver.extractAnswersMarkdown(answers), 'The answer is 42');

    const contents = [
      { url: 'https://a.com', title: 'A', markdown: '# A\n' },
      { url: 'https://b.com', title: 'B', markdown: '# B\n' },
    ];
    const pages = saver.extractContentsPages(contents);
    assert.equal(pages.length, 2);
    assert.equal(pages[0].markdown, '# A\n');
    assert.equal(pages[1].markdown, '# B\n');
  });

  it('Save Again writes new timestamp without changing content', () => {
    const md = 'retained content ✓';
    const r1 = saver.atomicWrite(dir, md, { when: new Date(2026, 0, 1, 12, 0, 0) });
    // Simulate Save Again with later timestamp
    const r2 = saver.atomicWrite(dir, md, { when: new Date(2026, 0, 1, 12, 0, 5) });
    assert.notEqual(r1.filename, r2.filename);
    assert.equal(fs.readFileSync(r2.path, 'utf8'), md);
  });
});
