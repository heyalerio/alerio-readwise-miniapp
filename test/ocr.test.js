import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractBookTextWithLocalOcr, extractBookTextWithOpenClaw } from '../src/ocr.js';

test('OpenClaw OCR adapter extracts outputs text', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'mentra-readwise-ocr-test-'));
  const previousPath = process.env.PATH;
  try {
    const fakeOpenClaw = path.join(tempDir, 'openclaw');
    await writeFile(
      fakeOpenClaw,
      '#!/bin/sh\nprintf \'{"ok":true,"outputs":[{"text":"TITLE: Test\\n[HIGHLIGHT] Extracted quote."}]}\\n\'\n'
    );
    await chmod(fakeOpenClaw, 0o755);
    process.env.PATH = `${tempDir}:${previousPath}`;

    const result = await extractBookTextWithOpenClaw({
      filePath: path.join(tempDir, 'page.jpg'),
      enabled: true,
      model: '',
      timeoutMs: 1000
    });

    assert.match(result.text, /TITLE: Test/);
    assert.match(result.text, /\[HIGHLIGHT\] Extracted quote/);
  } finally {
    process.env.PATH = previousPath;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('book OCR falls back to local OCR when OpenClaw is disabled', async () => {
  const result = await extractBookTextWithLocalOcr({
    filePath: '/tmp/page.jpg',
    execFileImpl: async () => ({
      stdout:
        'Good explanations are hard to vary because every detail plays a functional role in the whole explanation.\\n'
    })
  });

  assert.equal(result.provider, 'local_ocr');
  assert.equal(result.model, 'tesseract:eng');
  assert.match(result.text, /\[HIGHLIGHT\] Good explanations are hard to vary/);
  assert.match(result.text, /\[NOTE\] Captured from Mentra Live local OCR/);
});

test('OpenClaw OCR failures fall back to local OCR', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'mentra-readwise-ocr-fallback-test-'));
  const previousPath = process.env.PATH;
  try {
    const fakeOpenClaw = path.join(tempDir, 'openclaw');
    await writeFile(fakeOpenClaw, '#!/bin/sh\necho "no provider" >&2\nexit 1\n');
    await chmod(fakeOpenClaw, 0o755);

    const fakeTesseract = path.join(tempDir, 'tesseract');
    await writeFile(fakeTesseract, '#!/bin/sh\nprintf "Fallback book page quote from local OCR.\\n"\n');
    await chmod(fakeTesseract, 0o755);
    process.env.PATH = `${tempDir}:${previousPath}`;

    const result = await extractBookTextWithOpenClaw({
      filePath: path.join(tempDir, 'page.jpg'),
      enabled: true,
      model: '',
      timeoutMs: 1000
    });

    assert.equal(result.provider, 'local_ocr');
    assert.match(result.text, /\[HIGHLIGHT\] Fallback book page quote from local OCR/);
  } finally {
    process.env.PATH = previousPath;
    await rm(tempDir, { recursive: true, force: true });
  }
});
