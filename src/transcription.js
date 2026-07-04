import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { normalizeText } from './domain.js';

const execFileAsync = promisify(execFile);
const DEFAULT_OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_OPENCLAW_AUDIO_MODEL = 'openrouter/openai/whisper-large-v3-turbo';
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 15000;

export async function transcribeAudioRemotely({
  audioBuffer,
  mimeType = 'audio/wav',
  filename = 'mentra-audio.wav',
  provider = process.env.AUDIO_TRANSCRIPTION_PROVIDER || 'openclaw',
  model = getDefaultAudioTranscriptionModel(provider),
  apiKey = process.env.OPENAI_API_KEY,
  endpoint = process.env.OPENAI_TRANSCRIPTION_URL || DEFAULT_OPENAI_TRANSCRIPTION_URL,
  language = process.env.OPENAI_TRANSCRIPTION_LANGUAGE || '',
  prompt = process.env.OPENAI_TRANSCRIPTION_PROMPT || 'Transcribe the reader note from a book capture. Preserve book titles, page numbers, quoted passages, and action notes.',
  timeoutMs = Number(process.env.AUDIO_TRANSCRIPTION_TIMEOUT_MS || DEFAULT_TRANSCRIPTION_TIMEOUT_MS),
  fetchImpl = fetch
} = {}) {
  if (!audioBuffer?.byteLength) return { provider, model, text: '', skipped: 'empty_audio' };
  if (provider === 'off' || provider === 'disabled') return { provider, model, text: '', skipped: 'disabled' };
  if (provider === 'openclaw') {
    return transcribeAudioWithOpenClaw({ audioBuffer, model, language, prompt, timeoutMs });
  }
  if (provider !== 'openai') throw new Error(`Unsupported audio transcription provider: ${provider}`);
  if (!apiKey) return { provider, model, text: '', skipped: 'missing_openai_api_key' };

  const form = new FormData();
  form.set('file', new Blob([audioBuffer], { type: mimeType }), filename);
  form.set('model', model);
  form.set('response_format', 'json');
  if (language) form.set('language', language);
  if (prompt) form.set('prompt', prompt);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`OpenAI transcription failed: ${response.status} ${await response.text()}`);
    }

    const payload = await response.json();
    return {
      provider,
      model,
      text: normalizeText(payload?.text || '')
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function transcribeAudioWithOpenClaw({
  audioBuffer,
  model = process.env.OPENCLAW_AUDIO_MODEL || DEFAULT_OPENCLAW_AUDIO_MODEL,
  language = process.env.OPENCLAW_AUDIO_LANGUAGE || process.env.OPENAI_TRANSCRIPTION_LANGUAGE || '',
  prompt = process.env.OPENCLAW_AUDIO_PROMPT || process.env.OPENAI_TRANSCRIPTION_PROMPT || '',
  timeoutMs = Number(process.env.AUDIO_TRANSCRIPTION_TIMEOUT_MS || DEFAULT_TRANSCRIPTION_TIMEOUT_MS),
  execFileImpl = execFileAsync
} = {}) {
  if (!audioBuffer?.byteLength) return { provider: 'openclaw', model, text: '', skipped: 'empty_audio' };

  const tempPath = path.join(os.tmpdir(), `mentra-wip-audio-${process.pid}-${randomUUID()}.wav`);
  await fs.writeFile(tempPath, audioBuffer);
  try {
    const args = ['infer', 'audio', 'transcribe', '--file', tempPath, '--json'];
    if (model) args.push('--model', model);
    if (language) args.push('--language', language);
    if (prompt) args.push('--prompt', prompt);

    const { stdout } = await execFileImpl('openclaw', args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    });
    return {
      provider: 'openclaw',
      model,
      text: normalizeText(extractTranscriptText(stdout))
    };
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

export function pcm16ToWav(pcmBuffer, { sampleRate = 16000, channels = 1 } = {}) {
  const pcm = Buffer.from(pcmBuffer || Buffer.alloc(0));
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

export function normalizeAudioChunkBuffer(chunk = {}) {
  const value = chunk.arrayBuffer || chunk.buffer || chunk.data;
  if (!value) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Buffer.from(value);
  return Buffer.alloc(0);
}

function getDefaultAudioTranscriptionModel(provider) {
  if (provider === 'openai') return process.env.OPENAI_TRANSCRIPTION_MODEL || DEFAULT_TRANSCRIPTION_MODEL;
  return process.env.OPENCLAW_AUDIO_MODEL || DEFAULT_OPENCLAW_AUDIO_MODEL;
}

function extractTranscriptText(stdout = '') {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return '';

  try {
    const parsed = JSON.parse(trimmed);
    const found = findText(parsed);
    if (found) return found;
  } catch (_error) {
    // Provider-backed tools may return plain text if JSON is unavailable.
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
    for (const key of ['text', 'transcript', 'result', 'output', 'outputs', 'content', 'message']) {
      const found = findText(value[key]);
      if (found) return found;
    }
  }
  return '';
}
