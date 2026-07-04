import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildApprovalDraft,
  buildReadwisePayload,
  buildTraceMetadata,
  extractHighlight,
  parseOcrText,
  sendReadwiseHighlight
} from '../src/domain.js';

const SAMPLE_OCR = `TITLE: The Beginning of Infinity
AUTHOR: David Deutsch
PAGE: 42

[HIGHLIGHT] Good explanations are hard to vary because every detail plays a functional role.
[NOTE] Useful for product design decisions.`;

test('parses OCR text metadata and body', () => {
  const ocr = parseOcrText(SAMPLE_OCR);

  assert.equal(ocr.title, 'The Beginning of Infinity');
  assert.equal(ocr.author, 'David Deutsch');
  assert.equal(ocr.page, 42);
  assert.match(ocr.text, /Good explanations/);
});

test('extracts highlight and note', () => {
  const highlight = extractHighlight(parseOcrText(SAMPLE_OCR));

  assert.match(highlight.text, /hard to vary/);
  assert.match(highlight.note, /product design/);
});

test('builds a Readwise payload', () => {
  const payload = buildReadwisePayload(extractHighlight(parseOcrText(SAMPLE_OCR)));

  assert.equal(payload.body.highlights.length, 1);
  assert.equal(payload.body.highlights[0].category, 'books');
  assert.equal(payload.body.highlights[0].location, 42);
});

test('builds an approval draft before Readwise dispatch', () => {
  const draft = buildApprovalDraft({
    ocrText: SAMPLE_OCR,
    imageUrl: 'https://example.com/page.jpg',
    requestId: 'test_20260701_123456Z_book_page_1782865000000',
    testRunId: 'test_20260701_123456Z'
  });

  assert.equal(draft.status, 'pending_approval');
  assert.equal(draft.target, 'readwise');
  assert.equal(draft.imageUrl, 'https://example.com/page.jpg');
  assert.deepEqual(draft.metadata, {
    requestId: 'test_20260701_123456Z_book_page_1782865000000',
    testRunId: 'test_20260701_123456Z'
  });
  assert.deepEqual(buildTraceMetadata({ requestId: ' run 1 ' }), { requestId: 'run_1' });
  assert.doesNotMatch(JSON.stringify(draft.readwisePayload), /test_20260701_123456Z/);
});

test('Readwise dispatch is dry-run unless explicitly enabled', async () => {
  const draft = buildApprovalDraft({ ocrText: SAMPLE_OCR });
  const result = await sendReadwiseHighlight({ payload: draft.readwisePayload });

  assert.equal(result.mode, 'dry_run');
  assert.equal(result.wouldSend.endpoint, 'POST https://readwise.io/api/v2/highlights/');
});
