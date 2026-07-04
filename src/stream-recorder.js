import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function startManagedStreamRecording({
  inputUrl,
  outputPath,
  maxSeconds = 0,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  fetchImpl = fetch
} = {}) {
  if (!isHttpUrl(inputUrl)) throw new Error('A valid HLS input URL is required to record a managed stream.');
  if (!outputPath) throw new Error('outputPath is required to record a managed stream.');

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await waitForStreamInput({
    inputUrl,
    timeoutMs: getReadyTimeoutMs(),
    intervalMs: getReadyIntervalMs(),
    fetchImpl
  });

  const args = [
    '-hide_banner',
    '-loglevel',
    process.env.READWISE_STREAM_RECORDING_LOGLEVEL || 'warning',
    '-nostdin',
    '-y'
  ];
  if (Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0) {
    args.push('-t', String(Math.floor(Number(maxSeconds))));
  }
  args.push('-i', inputUrl, '-c', 'copy', '-movflags', '+faststart', outputPath);

  const child = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'ignore', 'pipe']
  });

  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4000);
  });

  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      try {
        const stat = await fs.stat(outputPath);
        if (stat.size > 0 && (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM')) {
          resolve({
            code,
            signal,
            outputPath,
            size: stat.size,
            stderr: stderr.trim()
          });
          return;
        }
      } catch (_error) {
        // Report the ffmpeg error below with stderr context.
      }

      reject(new Error(`stream_recorder_failed code=${code ?? 'null'} signal=${signal || 'none'} ${stderr.trim()}`.trim()));
    });
  });

  return {
    process: child,
    done,
    stop: async ({ timeoutMs = getStopTimeoutMs() } = {}) => {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill('SIGINT');
      }

      let timer = null;
      if (Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0) {
        timer = setTimeout(() => {
          if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
        }, Number(timeoutMs));
        timer.unref?.();
      }

      try {
        return await done;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  };
}

export async function remuxRecordingToMp4({
  inputPath,
  outputPath,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
} = {}) {
  if (!inputPath) throw new Error('inputPath is required to remux a recording.');
  if (!outputPath) throw new Error('outputPath is required to remux a recording.');

  await waitForReadableFile(inputPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const args = [
    '-hide_banner',
    '-loglevel',
    process.env.READWISE_STREAM_RECORDING_LOGLEVEL || 'warning',
    '-nostdin',
    '-y',
    '-i',
    inputPath,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    outputPath
  ];
  const child = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'ignore', 'pipe']
  });

  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4000);
  });

  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      try {
        const stat = await fs.stat(outputPath);
        if (stat.size > 0 && code === 0) {
          resolve({
            code,
            signal,
            inputPath,
            outputPath,
            size: stat.size,
            stderr: stderr.trim()
          });
          return;
        }
      } catch (_error) {
        // Report the ffmpeg error below with stderr context.
      }

      reject(new Error(`stream_remux_failed code=${code ?? 'null'} signal=${signal || 'none'} ${stderr.trim()}`.trim()));
    });
  });
}

export async function extractAudioToM4a({
  inputPath,
  outputPath,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
} = {}) {
  if (!inputPath) throw new Error('inputPath is required to extract stream audio.');
  if (!outputPath) throw new Error('outputPath is required to extract stream audio.');

  await waitForReadableFile(inputPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const args = [
    '-hide_banner',
    '-loglevel',
    process.env.READWISE_STREAM_RECORDING_LOGLEVEL || 'warning',
    '-nostdin',
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-map',
    '0:a:0',
    '-c:a',
    'copy',
    outputPath
  ];
  const child = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'ignore', 'pipe']
  });

  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4000);
  });

  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      try {
        const stat = await fs.stat(outputPath);
        if (stat.size > 0 && code === 0) {
          resolve({
            code,
            signal,
            inputPath,
            outputPath,
            size: stat.size,
            stderr: stderr.trim()
          });
          return;
        }
      } catch (_error) {
        // Report the ffmpeg error below with stderr context.
      }

      reject(new Error(`stream_audio_extract_failed code=${code ?? 'null'} signal=${signal || 'none'} ${stderr.trim()}`.trim()));
    });
  });
}

export async function waitForStreamInput({
  inputUrl,
  timeoutMs = getReadyTimeoutMs(),
  intervalMs = getReadyIntervalMs(),
  fetchImpl = fetch
} = {}) {
  if (!isHttpUrl(inputUrl)) throw new Error('A valid stream input URL is required.');

  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 0 ? Number(timeoutMs) : 0;
  const interval = Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0 ? Number(intervalMs) : 1000;
  const deadline = Date.now() + timeout;
  let lastError = null;

  while (true) {
    try {
      const response = await fetchImpl(inputUrl, {
        method: 'GET',
        headers: {
          'cache-control': 'no-cache',
          pragma: 'no-cache'
        }
      });
      if (response.ok) {
        await drainResponseBody(response);
        return {
          ok: true,
          status: response.status,
          inputUrl
        };
      }
      lastError = new Error(`stream_input_not_ready status=${response.status}`);
      await drainResponseBody(response);
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= deadline) {
      throw new Error(`stream_input_not_ready timeout=${timeout}ms ${errorMessage(lastError)}`.trim());
    }

    await delay(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
}

function isHttpUrl(value = '') {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

function getStopTimeoutMs() {
  const parsed = Number(process.env.READWISE_STREAM_RECORDING_STOP_TIMEOUT_MS || 8000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 8000;
}

function getReadyTimeoutMs() {
  const parsed = Number(process.env.READWISE_STREAM_RECORDING_HLS_READY_TIMEOUT_MS || 45000);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 45000;
}

function getReadyIntervalMs() {
  const parsed = Number(process.env.READWISE_STREAM_RECORDING_HLS_READY_INTERVAL_MS || 1500);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1500;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReadableFile(filePath, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previousSize = -1;

  while (Date.now() <= deadline) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 0 && stat.size === previousSize) return stat;
      previousSize = stat.size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(intervalMs);
  }

  throw new Error(`recording_file_not_ready ${filePath}`);
}

async function drainResponseBody(response) {
  try {
    await response.arrayBuffer();
  } catch (_error) {
    // Best-effort body drain so keep-alive sockets are reusable.
  }
}

function errorMessage(error) {
  return error?.message || String(error || '');
}
