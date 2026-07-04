import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function extractBookTextWithOpenClaw({
  filePath,
  enabled = process.env.OPENCLAW_IMAGE_DESCRIBE === '1',
  model = process.env.OPENCLAW_IMAGE_MODEL || 'openrouter/auto',
  timeoutMs = Number(process.env.OPENCLAW_IMAGE_TIMEOUT_MS || 120000),
  localOcrEnabled = process.env.LOCAL_IMAGE_OCR !== '0',
  localOcrTimeoutMs = Number(process.env.LOCAL_IMAGE_OCR_TIMEOUT_MS || 45000),
  localOcrLang = process.env.LOCAL_IMAGE_OCR_LANG || 'eng'
} = {}) {
  if ((enabled || localOcrEnabled) && !filePath) throw new Error('filePath is required for OCR.');

  let openClawError = null;
  if (enabled) {
    try {
      const prompt = [
        'Extract readable text from this book page photo.',
        'Return plain text in this exact loose format when possible:',
        'TITLE: <book title if visible or known from page>',
        'AUTHOR: <author if visible>',
        'PAGE: <page number if visible>',
        '',
        '[HIGHLIGHT] <the most useful highlight-length passage visible on the page>',
        '[NOTE] Captured from Mentra Live for Readwise review.',
        'If the page is unreadable, return [HIGHLIGHT] OCR pending and do not invent text.'
      ].join('\n');

      const args = [
        'infer',
        'image',
        'describe',
        '--file',
        filePath,
        '--json',
        '--timeout-ms',
        String(timeoutMs),
        '--prompt',
        prompt
      ];
      if (model) args.push('--model', model);

      const { stdout } = await execFileAsync('openclaw', args, {
        timeout: timeoutMs + 5000,
        maxBuffer: 1024 * 1024
      });

      const text = extractText(stdout);
      if (text) {
        return {
          provider: 'openclaw',
          model,
          text
        };
      }
    } catch (error) {
      openClawError = error;
    }
  }

  if (localOcrEnabled) {
    try {
      return await extractBookTextWithLocalOcr({
        filePath,
        lang: localOcrLang,
        timeoutMs: localOcrTimeoutMs
      });
    } catch (_error) {
      // Local OCR is best-effort; the approval draft keeps the image for manual correction.
    }
  }

  return {
    provider: openClawError ? 'openclaw_failed' : 'disabled',
    model: enabled ? model : null,
    text: ''
  };
}

export async function extractBookTextWithLocalOcr({
  filePath,
  lang = 'eng',
  timeoutMs = 45000,
  execFileImpl = execFileAsync
} = {}) {
  if (!filePath) throw new Error('filePath is required for local OCR.');

  const { stdout } = await execFileImpl('tesseract', [filePath, 'stdout', '-l', lang, '--psm', '6'], {
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024
  });
  const text = normalizeOcrText(stdout);

  return {
    provider: 'local_ocr',
    model: `tesseract:${lang}`,
    text: buildReadwiseOcrText(text)
  };
}

function extractText(stdout = '') {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return '';

  try {
    const parsed = JSON.parse(trimmed);
    const found = findText(parsed);
    if (found) return found.trim();
  } catch (_error) {
    // OpenClaw may return plain text if a provider ignores --json.
  }

  return trimmed;
}

function findText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findText(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    for (const key of ['description', 'text', 'outputs', 'output', 'content', 'message', 'result']) {
      const found = findText(value[key]);
      if (found) return found;
    }
  }
  return '';
}

function buildReadwiseOcrText(text = '') {
  const normalized = normalizeOcrText(text);
  if (!normalized) return '';

  return [
    `[HIGHLIGHT] ${selectHighlight(normalized)}`,
    '[NOTE] Captured from Mentra Live local OCR for Readwise review.'
  ].join('\n');
}

function selectHighlight(text = '') {
  const paragraph =
    String(text)
      .split(/\n\s*\n/)
      .map((part) => normalizeOcrText(part))
      .find((part) => part.length >= 24) || normalizeOcrText(text);
  return paragraph.slice(0, 900);
}

function normalizeOcrText(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim();
}
