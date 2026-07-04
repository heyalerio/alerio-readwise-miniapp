import 'dotenv/config';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const checks = [];

await ensureRuntimeDirs();
checkNodeVersion();
checkFile(process.env.DOTENV_CONFIG_PATH || '.env', process.env.DOTENV_CONFIG_PATH ? 'configured environment file' : 'local environment file');
checkCommand('ffmpeg', 'required for video remuxing and frame extraction');
checkCommand('ffprobe', 'required for video duration probing');
checkCommand('tesseract', 'optional local OCR dedupe fallback', { optional: true });
checkBaseConfig();
checkRtmpConfig();
checkWorkerConfig();
checkTelegramConfig();
checkReadwiseWrites();

printResults();
const failed = checks.filter((check) => check.level === 'fail');
if (failed.length) process.exitCode = 1;

async function ensureRuntimeDirs() {
  await mkdir(env('MEDIA_DIR') || path.join(process.cwd(), 'data', 'media'), { recursive: true });
  await mkdir(env('READWISE_RTMP_RECORD_DIR') || path.join(process.cwd(), 'data', 'rtmp-recordings'), { recursive: true });
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 20 && major < 24 ? 'ok' : 'fail', `Node.js ${process.versions.node}`, 'Node.js 20, 21, 22, or 23 is required.');
}

function checkBaseConfig() {
  checkEnv('MENTRA_PACKAGE_NAME', 'Mentra package name');
  checkEnv('MENTRA_API_KEY', 'Mentra API key', { secret: true, realUse: true });
  checkEnv('PUBLIC_URL', 'public HTTPS app URL', { rejectExample: true, realUse: true });
  checkEnv('READWISE_REVIEW_TOKEN', 'private review token', { secret: true, realUse: true });
  checkEnv('READWISE_MEDIA_TOKEN_SECRET', 'private media link signing secret', { secret: true, realUse: true });
}

function checkRtmpConfig() {
  if (env('READWISE_RTMP_INGEST_ENABLED') !== '1') {
    add('warn', 'RTMP ingest disabled', 'Set READWISE_RTMP_INGEST_ENABLED=1 for glasses streaming.');
    return;
  }
  checkEnv('READWISE_RTMP_PUBLIC_HOST', 'public RTMP host', { rejectExample: true, realUse: true });
  checkEnv('READWISE_RTMP_INGEST_SECRET', 'RTMP publish signing secret', { secret: true, realUse: true });
  checkEnv('READWISE_RTMP_INGEST_PORT', 'RTMP TCP port');
}

function checkWorkerConfig() {
  if (env('READWISE_VIDEO_HIGHLIGHT_OCR') !== '1') {
    add('warn', 'highlight OCR disabled', 'Set READWISE_VIDEO_HIGHLIGHT_OCR=1 for the full extraction pipeline.');
    return;
  }

  const provider = env('READWISE_VIDEO_HIGHLIGHT_OCR_PROVIDER') || (env('OPENAI_API_KEY') ? 'openai' : 'openclaw');
  if (provider === 'openai') checkEnv('OPENAI_API_KEY', 'OpenAI API key for highlight OCR', { secret: true, realUse: true });
  if (provider === 'openrouter') checkEnv('OPENROUTER_API_KEY', 'OpenRouter API key for highlight OCR', { secret: true, realUse: true });
  if (provider === 'openclaw') checkCommand('openclaw', 'OpenClaw CLI for highlight OCR');
  if (!['openai', 'openrouter', 'openclaw', 'off', 'disabled'].includes(provider)) {
    add('fail', `unknown OCR provider ${provider}`, 'Use openai, openrouter, openclaw, off, or disabled.');
  }

  if (env('READWISE_VIDEO_AUDIO_TRANSCRIPTION') !== '0') {
    const audioProvider = env('AUDIO_TRANSCRIPTION_PROVIDER') || 'openclaw';
    if (audioProvider === 'openai') checkEnv('OPENAI_API_KEY', 'OpenAI API key for audio transcription', { secret: true, realUse: true });
    if (audioProvider === 'openclaw') checkCommand('openclaw', 'OpenClaw CLI for audio transcription');
    if (!['openai', 'openclaw', 'off', 'disabled'].includes(audioProvider)) {
      add('fail', `unknown audio transcription provider ${audioProvider}`, 'Use openai, openclaw, off, or disabled.');
    }
  }
}

function checkTelegramConfig() {
  if (env('READWISE_TELEGRAM_ENABLED') === '0') {
    add('warn', 'Telegram disabled', 'Review cards will not be sent.');
    return;
  }
  checkEnv('READWISE_TELEGRAM_BOT_TOKEN', 'Telegram bot token', { secret: true, realUse: true, optional: true });
  checkEnv('READWISE_TELEGRAM_CHAT_ID', 'Telegram chat id', { realUse: true, optional: true });
  checkEnv('READWISE_TELEGRAM_FORWARD_TOKEN', 'Telegram callback forward token', { secret: true, realUse: true, optional: true });
}

function checkReadwiseWrites() {
  if (env('READWISE_LIVE_WRITES') !== '1') {
    add('warn', 'Readwise live writes disabled', 'Good for setup. Set READWISE_LIVE_WRITES=1 only after review flow is tested.');
    return;
  }
  checkEnv('READWISE_TOKEN', 'Readwise API token', { secret: true, realUse: true });
  if (env('READWISE_APPROVAL_ENABLED') !== '1') {
    add('fail', 'approval callbacks disabled', 'Set READWISE_APPROVAL_ENABLED=1 before live Readwise writes.');
  }
}

function checkEnv(name, label, { rejectExample = false, secret = false, realUse = false, optional = false } = {}) {
  const value = env(name);
  if (!value) {
    add(optional ? 'warn' : realUse ? 'fail' : 'warn', `${label} not set`, `Set ${name}${secret ? ' in .env' : ''}.`);
    return;
  }
  if (rejectExample && /\.example\.com$|example\.com|rtmp\.example\.com/i.test(value)) {
    add(realUse ? 'fail' : 'warn', `${label} still uses example value`, `Replace ${name} with your deployment value.`);
    return;
  }
  add('ok', `${label} configured`, `${name} is set.`);
}

function checkCommand(command, detail, { optional = false } = {}) {
  const result =
    process.platform === 'win32'
      ? spawnSync('where', [command], { encoding: 'utf8', stdio: 'ignore' })
      : spawnSync('sh', ['-c', `command -v ${shellQuote(command)}`], { encoding: 'utf8', stdio: 'ignore' });
  add(result.status === 0 ? 'ok' : optional ? 'warn' : 'fail', `${command} ${result.status === 0 ? 'found' : 'missing'}`, detail);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function checkFile(filePath, label) {
  if (existsSync(filePath)) {
    add('ok', `${label} found`, filePath);
    return;
  }
  add('fail', `${label} missing`, `Run npm run setup to create ${filePath}.`);
}

function env(name) {
  return String(process.env[name] || '').trim();
}

function add(level, title, detail = '') {
  checks.push({ level, title, detail });
}

function printResults() {
  const icon = { ok: 'OK', warn: 'WARN', fail: 'FAIL' };
  for (const check of checks) {
    console.log(`[${icon[check.level]}] ${check.title}${check.detail ? ` - ${check.detail}` : ''}`);
  }

  const counts = checks.reduce((acc, check) => ({ ...acc, [check.level]: (acc[check.level] || 0) + 1 }), {});
  console.log('');
  console.log(`Summary: ${counts.ok || 0} ok, ${counts.warn || 0} warnings, ${counts.fail || 0} failures.`);
  if (counts.fail) console.log('Fix failures before running the full glasses pipeline.');
}
