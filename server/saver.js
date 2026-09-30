'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

/**
 * Local-time filename: MM-DD:HHMM.SS.md or MM-DD:HHMM.SS-01.md
 * @param {Date} [when]
 * @param {number|null} [pageIndex] — 1-based for multi-page Contents
 */
function makeFilename(when = new Date(), pageIndex = null) {
  const d = when instanceof Date ? when : new Date(when);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const HH = String(d.getHours()).padStart(2, '0');
  const MM = String(d.getMinutes()).padStart(2, '0');
  const SS = String(d.getSeconds()).padStart(2, '0');
  const base = `${mm}-${dd}:${HH}${MM}.${SS}`;
  if (pageIndex != null) {
    const n = String(pageIndex).padStart(2, '0');
    return `${base}-${n}.md`;
  }
  return `${base}.md`;
}

/**
 * Atomic write: temp → flush → rename → confirm exists.
 * Content is written byte-for-byte (utf8 string as-is).
 *
 * @param {string} destDir
 * @param {string} content
 * @param {{ filename?: string, pageIndex?: number|null, when?: Date }} [opts]
 * @returns {{ ok: true, path: string, filename: string, bytes: number } | { ok: false, error: string }}
 */
function atomicWrite(destDir, content, opts = {}) {
  if (!destDir) {
    return { ok: false, error: 'Output directory is not set' };
  }
  const when = opts.when || new Date();
  const filename =
    opts.filename ||
    makeFilename(when, opts.pageIndex != null ? opts.pageIndex : null);
  const finalPath = path.join(destDir, filename);
  const tmpPath = path.join(
    destDir,
    `.${filename}.${process.pid}.${Date.now()}.tmp`
  );

  try {
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    const fd = fs.openSync(tmpPath, 'w');
    try {
      const buf = Buffer.from(String(content), 'utf8');
      fs.writeSync(fd, buf, 0, buf.length, 0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, finalPath);
    if (!fs.existsSync(finalPath)) {
      return { ok: false, error: `Verification failed: ${finalPath} does not exist after rename` };
    }
    const bytes = fs.statSync(finalPath).size;
    log('success', 'file verified', {
      operation: 'save',
      outcome: 'verified',
      details: { path: finalPath, bytes },
    });
    return { ok: true, path: finalPath, filename, bytes };
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {
      /* ignore */
    }
    log('error', 'file write failed', {
      operation: 'save',
      outcome: 'failed',
      details: { error: err.message, path: finalPath },
    });
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Extract Markdown from Answers / Contents / Research responses.
 * Research: result.output.content
 * Answers: answer string alone (byte-faithful)
 * Contents: each page's markdown field
 */
function extractResearchMarkdown(taskResult) {
  if (!taskResult) return '';
  const output = taskResult.result?.output || taskResult.output || taskResult;
  if (typeof output === 'string') return output;
  if (output && typeof output.content === 'string') return output.content;
  return '';
}

function extractAnswersMarkdown(answerResponse) {
  if (!answerResponse) return '';
  if (typeof answerResponse.answer === 'string') return answerResponse.answer;
  if (typeof answerResponse === 'string') return answerResponse;
  return '';
}

/**
 * @param {Array|{results?: Array}} contentsResponse
 * @returns {Array<{ url: string, title: string, markdown: string }>}
 */
function extractContentsPages(contentsResponse) {
  let pages = contentsResponse;
  if (contentsResponse && Array.isArray(contentsResponse.results)) {
    pages = contentsResponse.results;
  }
  if (!Array.isArray(pages)) return [];
  return pages.map((p) => ({
    url: p.url || '',
    title: p.title || '',
    markdown: typeof p.markdown === 'string' ? p.markdown : '',
  }));
}

module.exports = {
  makeFilename,
  atomicWrite,
  extractResearchMarkdown,
  extractAnswersMarkdown,
  extractContentsPages,
};
