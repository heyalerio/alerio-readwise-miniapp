import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MentraBookReadwiseApp } from '../src/app.js';
import { processQueuedVideoDrafts } from '../src/video-worker.js';

const SAMPLE_OCR = `TITLE: Test Book
AUTHOR: Mentra Tester
PAGE: 12
[HIGHLIGHT] Keep real page captures approval-gated.
[NOTE] Smoke test.`;

test('serves root status and empty pending highlight list', async () => {
  await withTestServer(async (baseUrl) => {
    const root = await fetch(`${baseUrl}/`);
    assert.equal(root.status, 200);
    const status = await root.json();
    assert.equal(status.app, 'com.alerio.mentra.bookreadwise');
    assert.equal(status.mode, 'dry_run');

    const highlights = await fetch(`${baseUrl}/api/highlights`);
    assert.deepEqual(await highlights.json(), { highlights: [] });

    const media = await fetch(`${baseUrl}/api/media`);
    assert.deepEqual(await media.json(), { media: [] });
  });
});

test('serves a publish manifest for Mentra developer console setup', async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/.well-known/mentra-app.json`);
    assert.equal(response.status, 200);
    const manifest = await response.json();

    assert.equal(manifest.name, 'Alerio Readwise');
    assert.equal(manifest.packageName, 'com.alerio.mentra.bookreadwise.test');
    assert.equal(manifest.appUrl, baseUrl);
    assert.equal(manifest.reviewUrl, `${baseUrl}/review`);
    assert.equal(manifest.healthUrl, `${baseUrl}/health`);
    assert.equal(manifest.iconUrl, `${baseUrl}/assets/app-icon.png`);
    assert.equal(manifest.bridgeAuthRequired, false);
    assert.equal(manifest.writeMode, 'dry_run');
    assert.equal(manifest.testing.noWriteDefault, true);
    assert.equal(manifest.endpoints.authCheck, `${baseUrl}/api/bridge-auth-check`);
    assert.deepEqual(manifest.endpoints.capture, [`${baseUrl}/webhooks/mentra/book-video`]);
    assert.equal(manifest.mentraDeveloperConsole.webhookUrl, baseUrl);
    assert(!JSON.stringify(manifest).includes('apiKey'));
  });
});

test('creates, dry-run approves, and rejects Readwise highlight drafts', async () => {
  await withTestServer(async (baseUrl) => {
    const capture = await fetch(`${baseUrl}/webhooks/mentra/book-page`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ocrText: SAMPLE_OCR,
        imageUrl: 'https://example.com/page.jpg',
        requestId: 'test_20260701_123456Z_book_page_1782865000000'
      })
    });
    assert.equal(capture.status, 201);
    const created = await capture.json();
    assert.match(created.id, /^highlight_/);

    const list = await fetch(`${baseUrl}/api/highlights`);
    assert.equal((await list.json()).highlights.length, 1);

    const approve = await fetch(`${baseUrl}/webhooks/mentra/book-page/${created.id}/approve`, {
      method: 'POST'
    });
    assert.equal(approve.status, 200);
    const approved = await approve.json();
    assert.equal(approved.status, 'approved');
    assert.equal(approved.result.mode, 'dry_run');

    const second = await fetch(`${baseUrl}/webhooks/mentra/book-page`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ocrText: SAMPLE_OCR })
    });
    const secondCreated = await second.json();
    const reject = await fetch(`${baseUrl}/webhooks/mentra/book-page/${secondCreated.id}/reject`, {
      method: 'POST'
    });
    assert.equal(reject.status, 200);
    assert.deepEqual(await reject.json(), { status: 'rejected' });
  });
});

test('review page renders prefixed approve and reject forms', async () => {
  await withTestServer(async (baseUrl) => {
    await fetch(`${baseUrl}/webhooks/mentra/book-page`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ocrText: SAMPLE_OCR,
        imageUrl: 'https://example.com/page.jpg',
        requestId: 'test_20260701_123456Z_book_page_1782865000000'
      })
    });

    const review = await fetch(`${baseUrl}/review`, {
      headers: {
        accept: 'text/html',
        'x-forwarded-prefix': '/mentra-readwise'
      }
    });
    assert.equal(review.status, 200);
    const html = await review.text();
    assert.match(html, /Mentra Readwise Review/);
    assert.match(html, /src="\/mentra-readwise\/assets\/app-icon\.svg"/);
    assert.match(html, /Test run: test_20260701_123456Z/);
    assert.match(html, /Request: test_20260701_123456Z_book_page_1782865000000/);
    assert.match(html, /Keep real page captures approval-gated/);
    assert.match(html, /action="\/mentra-readwise\/webhooks\/mentra\/book-video"/);
    assert.match(html, /action="\/mentra-readwise\/webhooks\/mentra\/book-page"/);
    assert.match(html, /action="\/mentra-readwise\/webhooks\/mentra\/book-page\/highlight_[^"]+\/approve"/);
    assert.match(html, /action="\/mentra-readwise\/webhooks\/mentra\/book-page\/highlight_[^"]+\/reject"/);
  });
});

test('review page form posts redirect back to review', async () => {
  await withTestServer(async (baseUrl) => {
    const draft = await fetch(`${baseUrl}/webhooks/mentra/book-page`, {
      method: 'POST',
      headers: {
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-prefix': '/mentra-readwise'
      },
      body: new URLSearchParams({ ocrText: SAMPLE_OCR, imageUrl: 'https://example.com/page.jpg' }),
      redirect: 'manual'
    });
    assert.equal(draft.status, 302);
    assert.equal(draft.headers.get('location'), '/mentra-readwise/review?status=drafted');

    const list = await fetch(`${baseUrl}/api/highlights`);
    const { highlights } = await list.json();
    const approve = await fetch(`${baseUrl}/webhooks/mentra/book-page/${highlights[0].id}/approve`, {
      method: 'POST',
      headers: {
        accept: 'text/html',
        'x-forwarded-prefix': '/mentra-readwise'
      },
      redirect: 'manual'
    });
    assert.equal(approve.status, 302);
    assert.equal(approve.headers.get('location'), '/mentra-readwise/review?status=approved');
  });
});

test('media store saves captured page photos and serves them by unguessable filename', async () => {
  await withTestServer(async (baseUrl, context) => {
    const media = await context.app.mediaStore.savePhoto(
      {
        buffer: Buffer.from('fake-page'),
        mimeType: 'image/jpeg',
        filename: 'page.jpg',
        requestId: 'photo_req_page',
        size: 9,
        timestamp: new Date()
      },
      { publicBaseUrl: baseUrl, label: 'book_page' }
    );

    assert.match(media.url, new RegExp(`^${baseUrl}/media/book_page_`));
    const response = await fetch(media.url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'fake-page');
  });
});

test('direct page image uploads are stored, OCRed, and queued for approval', async () => {
  await withTestServer(async (baseUrl) => {
    const capture = await fetch(`${baseUrl}/webhooks/mentra/book-page`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'bridge_json_readwise_1',
        testRunId: 'run 1',
        imageBase64: Buffer.from('direct-page').toString('base64'),
        imageMimeType: 'image/jpeg',
        imageFileName: 'page.jpg',
        transcript: 'scan page'
      })
    });
    assert.equal(capture.status, 201);
    const created = await capture.json();
    assert.match(created.id, /^highlight_/);
    assert.deepEqual(created.draft.metadata, { requestId: 'bridge_json_readwise_1', testRunId: 'run_1' });
    assert.equal(created.draft.highlight.text, 'Keep real page captures approval-gated.');
    assert.match(created.draft.imageUrl, new RegExp(`^${baseUrl}/media/book_page_`));

    const media = await fetch(created.draft.imageUrl);
    assert.equal(media.status, 200);
    assert.equal(await media.text(), 'direct-page');

    const reject = await fetch(`${baseUrl}/webhooks/mentra/book-page/${created.id}/reject`, {
      method: 'POST'
    });
    assert.equal(reject.status, 200);
  });
});

test('SDK-style multipart page photos are OCRed and queued for approval', async () => {
  await withTestServer(async (baseUrl) => {
    const form = new FormData();
    form.set('requestId', 'photo_req_readwise_sdk');
    form.set('transcript', 'scan page');
    form.set('photo', new Blob(['sdk-page-photo'], { type: 'image/jpeg' }), 'book-page.jpg');

    const capture = await fetch(`${baseUrl}/webhooks/mentra/book-page`, {
      method: 'POST',
      body: form
    });
    assert.equal(capture.status, 201);
    const created = await capture.json();
    assert.match(created.id, /^highlight_/);
    assert.deepEqual(created.draft.metadata, { requestId: 'photo_req_readwise_sdk' });
    assert.equal(created.draft.highlight.text, 'Keep real page captures approval-gated.');
    assert.match(created.draft.imageUrl, new RegExp(`^${baseUrl}/media/book_page_`));

    const media = await fetch(created.draft.imageUrl);
    assert.equal(media.status, 200);
    assert.equal(await media.text(), 'sdk-page-photo');

    const reject = await fetch(`${baseUrl}/webhooks/mentra/book-page/${created.id}/reject`, {
      method: 'POST'
    });
    assert.equal(reject.status, 200);
  });
});

test('multipart book videos are stored for review without local frame processing by default', async () => {
  await withTestServer(async (baseUrl) => {
    const form = new FormData();
    form.set('requestId', 'video_req_readwise_storage');
    form.set('transcript', 'this passage changes how I think about attention');
    form.set('video', new Blob(['stored-video'], { type: 'video/mp4' }), 'reading-session.mp4');

    const capture = await fetch(`${baseUrl}/webhooks/mentra/book-video`, {
      method: 'POST',
      body: form
    });
    assert.equal(capture.status, 201);
    const created = await capture.json();
    assert.match(created.id, /^highlight_/);
    assert.equal(created.draft.sourceKind, 'book_video');
    assert.deepEqual(created.draft.metadata, { requestId: 'video_req_readwise_storage' });
    assert.equal(
      created.draft.highlight.text,
      'Stored reading video pending review. Open the source video and add the final highlight text before sending to Readwise.'
    );
    assert.equal(created.draft.highlight.note, 'this passage changes how I think about attention');
    assert.match(created.draft.videoUrl, new RegExp(`^${baseUrl}/media/book_video_`));
    assert.deepEqual(created.draft.frameUrls, []);
    assert.equal(created.draft.imageUrl, null);
    assert.equal(created.draft.processing.mode, 'stored_only');
    assert.equal(created.draft.processing.frameCount, 0);
    assert.equal(created.draft.processing.reason, 'deferred');
    assert.equal(created.draft.storage.mimeType, 'video/mp4');
    assert.equal(created.draft.storage.size, 'stored-video'.length);

    const video = await fetch(created.draft.videoUrl);
    assert.equal(video.status, 200);
    assert.equal(await video.text(), 'stored-video');

    const media = await fetch(`${baseUrl}/api/media`);
    const { media: storedMedia } = await media.json();
    assert.equal(storedMedia.length, 1);
    assert.equal(storedMedia[0].kind, 'video');
    assert.equal(storedMedia[0].mimeType, 'video/mp4');
    assert.equal(storedMedia[0].size, 'stored-video'.length);
    assert.equal(storedMedia[0].url, created.draft.videoUrl);

    const reject = await fetch(`${baseUrl}/webhooks/mentra/book-page/${created.id}/reject`, {
      method: 'POST'
    });
    assert.equal(reject.status, 200);
  });
});

test('stored book videos send pending draft notifications to Telegram when configured', async () => {
  const telegramCalls = [];
  await withTestServer(
    async (baseUrl) => {
      const form = new FormData();
      form.set('requestId', 'video_req_telegram');
      form.set('transcript', 'this page is about system memory');
      form.set('video', new Blob(['telegram-video'], { type: 'video/mp4' }), 'telegram-session.mp4');

      const capture = await fetch(`${baseUrl}/webhooks/mentra/book-video`, {
        method: 'POST',
        body: form
      });
      assert.equal(capture.status, 201);
      const created = await capture.json();
      assert.equal(created.draft.metadata.telegram.chatId, 'telegram-chat');
      assert.equal(created.draft.metadata.telegram.messageId, 'telegram-message-1');

      assert.equal(telegramCalls.length, 1);
      assert.match(telegramCalls[0].url, /\/sendMessage$/);
      assert.equal(telegramCalls[0].body.chat_id, 'telegram-chat');
      assert.match(telegramCalls[0].body.text, /Alerio Readwise recording saved/);
      assert.match(telegramCalls[0].body.text, /Book video/);
      assert.match(telegramCalls[0].body.text, /stored_only/);
      assert.match(telegramCalls[0].body.text, /this page is about system memory/);
      assert.match(telegramCalls[0].body.text, /separate worker/);
      assert.deepEqual(
        telegramCalls[0].body.reply_markup.inline_keyboard.map((row) => row[0].text),
        ['Open Review', 'Open Video']
      );
    },
    {
      telegramFetch: mockTelegramFetch(telegramCalls),
      telegramConfig: {
        READWISE_TELEGRAM_BOT_TOKEN: 'telegram-token',
        READWISE_TELEGRAM_CHAT_ID: 'telegram-chat'
      }
    }
  );
});

test('direct glasses RTMP stream stores video and audio as a Readwise review draft', async () => {
  const telegramCalls = [];
  const fakeRtmpServers = [];

  await withTestServer(
    async (baseUrl, { app, tempDir }) => {
      assert.equal(fakeRtmpServers.length, 1);
      assert.equal(fakeRtmpServers[0].config.rtmp.port, 31935);
      assert.equal(fakeRtmpServers[0].config.record.path, path.join(tempDir, 'rtmp'));

      const started = [];
      const stopped = [];
      const session = {
        camera: {
          startStream: async (options) => {
            started.push(options);
          },
          stopStream: async () => {
            stopped.push(true);
          },
          isCurrentlyStreaming: () => Boolean(app.videoStreamSessions.get('readwise-stream-session')?.active)
        },
        layouts: {
          showTextWall: () => null
        }
      };

      await app.startDirectRtmpVideoStream({
        session,
        sessionId: 'readwise-stream-session',
        reviewUrl: `${baseUrl}/review`
      });

      assert.equal(started.length, 1);
      assert.match(started[0].rtmpUrl, /^rtmp:\/\/rtmp\.example\.com:31935\/readwise\/s_/);
      assert.deepEqual(started[0].video, {
        width: 1280,
        height: 720,
        frameRate: 30,
        bitrate: 2500000
      });
      assert.equal(started[0].audio.bitrate, 128000);
      assert.equal(started[0].audio.sampleRate, 44100);

      const recording = app.streamRecordings.get('readwise-stream-session');
      assert.ok(recording);
      const streamDir = path.join(tempDir, 'rtmp', 'readwise', recording.rtmpStreamName);
      await mkdir(streamDir, { recursive: true });
      await writeFile(path.join(streamDir, 'recording.flv'), 'raw-rtmp-recording');

      await app.stopDirectRtmpVideoStream({
        session,
        sessionId: 'readwise-stream-session',
        reviewUrl: `${baseUrl}/review`
      });

      assert.equal(stopped.length, 1);
      const list = await fetch(`${baseUrl}/api/highlights`);
      const { highlights } = await list.json();
      assert.equal(highlights.length, 1);
      const draft = highlights[0].draft;
      assert.equal(draft.sourceKind, 'book_video');
      assert.equal(draft.processing.mode, 'queued');
      assert.equal(draft.processing.reason, 'stream_recorded_auto_queue');
      assert.match(draft.videoUrl, new RegExp(`^${baseUrl}/media/private/book_video_.*\\.mp4\\?mediaToken=`));
      assert.match(draft.audioUrl, new RegExp(`^${baseUrl}/media/private/book_video_audio_.*\\.m4a\\?mediaToken=`));
      assert.equal(draft.storage.mimeType, 'video/mp4');
      assert.equal(draft.audioStorage.mimeType, 'audio/mp4');

      const video = await fetch(draft.videoUrl);
      assert.equal(video.status, 200);
      assert.equal(await video.text(), 'mp4-video');

      const audio = await fetch(draft.audioUrl);
      assert.equal(audio.status, 200);
      assert.equal(await audio.text(), 'm4a-audio');

      const draftTelegram = telegramCalls.find((call) => /Alerio Readwise recording saved/.test(call.body.text));
      assert.ok(draftTelegram);
      assert.deepEqual(
        draftTelegram.body.reply_markup.inline_keyboard.map((row) => row[0].text),
        ['Open Review', 'Open Video', 'Open Audio']
      );
    },
    {
      telegramFetch: mockTelegramFetch(telegramCalls),
      telegramConfig: {
        READWISE_TELEGRAM_BOT_TOKEN: 'telegram-token',
        READWISE_TELEGRAM_CHAT_ID: 'telegram-chat'
      },
      env: {
        READWISE_RTMP_INGEST_ENABLED: '1',
        READWISE_RTMP_INGEST_SECRET: 'test-rtmp-secret',
        READWISE_RTMP_PUBLIC_HOST: 'rtmp.example.com',
        READWISE_RTMP_INGEST_PORT: '31935',
        READWISE_RTMP_RECORD_DIR: ({ tempDir }) => path.join(tempDir, 'rtmp'),
        READWISE_RTMP_FALLBACK_RECORDING_READY_INTERVAL_MS: '1',
        READWISE_RTMP_FALLBACK_RECORDING_STABLE_MS: '0',
        READWISE_MEDIA_TOKEN_SECRET: 'test-media-secret'
      },
      rtmpIngestServerFactory: (config) => {
        const server = {
          config,
          handlers: {},
          on(event, handler) {
            this.handlers[event] = handler;
          },
          run() {
            this.started = true;
          }
        };
        fakeRtmpServers.push(server);
        return server;
      },
      streamRemuxer: async ({ inputPath, outputPath }) => {
        assert.match(inputPath, /recording\.flv$/);
        await writeFile(outputPath, 'mp4-video');
        return { inputPath, outputPath, size: 'mp4-video'.length };
      },
      streamAudioExtractor: async ({ inputPath, outputPath }) => {
        assert.match(inputPath, /book_video_.*\.mp4$/);
        await writeFile(outputPath, 'm4a-audio');
        return { inputPath, outputPath, size: 'm4a-audio'.length };
      }
    }
  );
});

test('direct RTMP timeout status stores the completed raw recording', async () => {
  const fakeRtmpServers = [];

  await withTestServer(
    async (baseUrl, { app, tempDir }) => {
      const started = [];
      const sessionId = 'readwise-timeout-stream-session';
      const session = {
        camera: {
          startStream: async (options) => {
            started.push(options);
          },
          isCurrentlyStreaming: () => Boolean(app.videoStreamSessions.get(sessionId)?.active)
        },
        layouts: {
          showTextWall: () => null
        }
      };

      await app.startDirectRtmpVideoStream({
        session,
        sessionId,
        reviewUrl: `${baseUrl}/review`
      });

      assert.equal(started.length, 1);
      const recording = app.streamRecordings.get(sessionId);
      assert.ok(recording);
      const streamDir = path.join(tempDir, 'rtmp', 'readwise', recording.rtmpStreamName);
      await mkdir(streamDir, { recursive: true });
      await writeFile(path.join(streamDir, 'timeout-recording.flv'), 'raw-timeout-rtmp-recording');

      app.handleDirectRtmpStreamStatus({
        sessionId,
        status: {
          status: 'timeout',
          streamId: 'timeout-stream-id',
          stats: {
            bitrate: 2400000
          },
          resolvedConfig: {
            video: {
              width: 1280,
              height: 720
            }
          }
        }
      });

      const highlights = await waitForHighlights(baseUrl, 1);
      const draft = highlights[0].draft;
      assert.equal(draft.sourceKind, 'book_video');
      assert.equal(draft.processing.mode, 'queued');
      assert.match(draft.videoUrl, new RegExp(`^${baseUrl}/media/private/book_video_.*\\.mp4\\?mediaToken=`));
      assert.equal(app.videoStreamSessions.get(sessionId).status, 'timeout');
      assert.equal(app.videoStreamSessions.get(sessionId).needsStop, false);
      assert.deepEqual(app.videoStreamSessions.get(sessionId).streamStats, { bitrate: 2400000 });
      assert.deepEqual(app.videoStreamSessions.get(sessionId).resolvedConfig, { video: { width: 1280, height: 720 } });
    },
    {
      env: {
        READWISE_RTMP_INGEST_ENABLED: '1',
        READWISE_RTMP_INGEST_SECRET: 'test-rtmp-secret',
        READWISE_RTMP_PUBLIC_HOST: 'rtmp.example.com',
        READWISE_RTMP_INGEST_PORT: '31935',
        READWISE_RTMP_RECORD_DIR: ({ tempDir }) => path.join(tempDir, 'rtmp'),
        READWISE_RTMP_FALLBACK_RECORDING_READY_INTERVAL_MS: '1',
        READWISE_RTMP_FALLBACK_RECORDING_STABLE_MS: '0',
        READWISE_MEDIA_TOKEN_SECRET: 'test-media-secret'
      },
      rtmpIngestServerFactory: (config) => {
        const server = {
          config,
          handlers: {},
          on(event, handler) {
            this.handlers[event] = handler;
          },
          run() {
            this.started = true;
          }
        };
        fakeRtmpServers.push(server);
        return server;
      },
      streamRemuxer: async ({ inputPath, outputPath }) => {
        assert.match(inputPath, /timeout-recording\.flv$/);
        await writeFile(outputPath, 'timeout-mp4-video');
        return { inputPath, outputPath, size: 'timeout-mp4-video'.length };
      },
      streamAudioExtractor: async ({ outputPath }) => {
        await writeFile(outputPath, 'timeout-m4a-audio');
        return { outputPath, size: 'timeout-m4a-audio'.length };
      }
    }
  );
});

test('session button toggles direct RTMP recording without page capture', async () => {
  const fakeRtmpServers = [];

  await withTestServer(
    async (baseUrl, { app, tempDir }) => {
      const buttonHandlers = [];
      const started = [];
      const stopped = [];
      let photoRequests = 0;
      let transcriptionSubscriptions = 0;
      const sessionId = 'readwise-button-stream-session';
      const session = {
        camera: {
          startStream: async (options) => {
            started.push(options);
          },
          stopStream: async () => {
            stopped.push(true);
          },
          requestPhoto: async () => {
            photoRequests += 1;
            throw new Error('requestPhoto should not be used by Readwise session buttons');
          },
          isCurrentlyStreaming: () => Boolean(app.videoStreamSessions.get(sessionId)?.active),
          onStreamStatus: () => null
        },
        events: {
          onButtonPress: (handler) => {
            buttonHandlers.push(handler);
          },
          onTranscription: () => {
            transcriptionSubscriptions += 1;
          }
        },
        layouts: {
          showTextWall: () => null
        },
        audio: {
          speak: () => {
            throw new Error('Readwise recorder should not speak prompts');
          }
        }
      };

      await app.onSession(session, sessionId, 'test-user');
      assert.equal(buttonHandlers.length, 1);
      assert.equal(transcriptionSubscriptions, 0);

      await buttonHandlers[0]({ type: 'single_press' });
      assert.equal(started.length, 1);
      assert.equal(photoRequests, 0);

      const recording = app.streamRecordings.get(sessionId);
      assert.ok(recording);
      const streamDir = path.join(tempDir, 'rtmp', 'readwise', recording.rtmpStreamName);
      await mkdir(streamDir, { recursive: true });
      await writeFile(path.join(streamDir, 'recording.flv'), 'raw-rtmp-recording');

      await buttonHandlers[0]({ type: 'single_press' });
      assert.equal(stopped.length, 1);
      assert.equal(photoRequests, 0);

      const list = await fetch(`${baseUrl}/api/highlights`);
      const { highlights } = await list.json();
      assert.equal(highlights.length, 1);
      assert.equal(highlights[0].draft.sourceKind, 'book_video');
    },
    {
      env: {
        READWISE_RTMP_INGEST_ENABLED: '1',
        READWISE_RTMP_INGEST_SECRET: 'test-rtmp-secret',
        READWISE_RTMP_PUBLIC_HOST: 'rtmp.example.com',
        READWISE_RTMP_INGEST_PORT: '31935',
        READWISE_RTMP_RECORD_DIR: ({ tempDir }) => path.join(tempDir, 'rtmp'),
        READWISE_RTMP_FALLBACK_RECORDING_READY_INTERVAL_MS: '1',
        READWISE_RTMP_FALLBACK_RECORDING_STABLE_MS: '0',
        READWISE_MEDIA_TOKEN_SECRET: 'test-media-secret'
      },
      rtmpIngestServerFactory: (config) => {
        const server = {
          config,
          handlers: {},
          on(event, handler) {
            this.handlers[event] = handler;
          },
          run() {
            this.started = true;
          }
        };
        fakeRtmpServers.push(server);
        return server;
      },
      streamRemuxer: async ({ outputPath }) => {
        await writeFile(outputPath, 'mp4-video');
        return { outputPath, size: 'mp4-video'.length };
      },
      streamAudioExtractor: async ({ outputPath }) => {
        await writeFile(outputPath, 'm4a-audio');
        return { outputPath, size: 'm4a-audio'.length };
      }
    }
  );
});

test('session button ignores accidental duplicate stop while RTMP stream is initializing', async () => {
  const fakeRtmpServers = [];

  await withTestServer(
    async (_baseUrl, { app, tempDir }) => {
      const buttonHandlers = [];
      const started = [];
      const stopped = [];
      const messages = [];
      const sessionId = 'readwise-button-warmup-session';
      const session = {
        camera: {
          startStream: async (options) => {
            started.push(options);
          },
          stopStream: async () => {
            stopped.push(true);
          },
          isCurrentlyStreaming: () => started.length > 0 && stopped.length === 0,
          onStreamStatus: () => null
        },
        events: {
          onButtonPress: (handler) => {
            buttonHandlers.push(handler);
          }
        },
        layouts: {
          showTextWall: (message) => {
            messages.push(message);
          }
        },
        audio: {
          speak: () => {
            throw new Error('Readwise recorder should not speak prompts');
          }
        }
      };

      await app.onSession(session, sessionId, 'test-user');
      await buttonHandlers[0]({ type: 'single_press' });
      assert.equal(started.length, 1);

      app.handleDirectRtmpStreamStatus({
        sessionId,
        status: { status: 'initializing', streamId: 'stream-warmup' }
      });
      await buttonHandlers[0]({ type: 'single_press' });
      assert.equal(stopped.length, 0);
      assert(messages.some((message) => message.includes('starting')));

      const state = app.videoStreamSessions.get(sessionId);
      state.startedAt = new Date(Date.now() - 9000).toISOString();
      app.videoStreamSessions.set(sessionId, state);
      const recording = app.streamRecordings.get(sessionId);
      assert.ok(recording);
      const streamDir = path.join(tempDir, 'rtmp', 'readwise', recording.rtmpStreamName);
      await mkdir(streamDir, { recursive: true });
      await writeFile(path.join(streamDir, 'recording.flv'), 'raw-rtmp-recording');

      await buttonHandlers[0]({ type: 'single_press' });
      assert.equal(stopped.length, 1);
    },
    {
      env: {
        READWISE_RTMP_INGEST_ENABLED: '1',
        READWISE_RTMP_INGEST_SECRET: 'test-rtmp-secret',
        READWISE_RTMP_PUBLIC_HOST: 'rtmp.example.com',
        READWISE_RTMP_INGEST_PORT: '31935',
        READWISE_RTMP_RECORD_DIR: ({ tempDir }) => path.join(tempDir, 'rtmp'),
        READWISE_RTMP_FALLBACK_RECORDING_READY_INTERVAL_MS: '1',
        READWISE_RTMP_FALLBACK_RECORDING_STABLE_MS: '0',
        READWISE_MEDIA_TOKEN_SECRET: 'test-media-secret'
      },
      rtmpIngestServerFactory: (config) => {
        const server = {
          config,
          handlers: {},
          on(event, handler) {
            this.handlers[event] = handler;
          },
          run() {
            this.started = true;
          }
        };
        fakeRtmpServers.push(server);
        return server;
      },
      streamRemuxer: async ({ outputPath }) => {
        await writeFile(outputPath, 'mp4-video');
        return { outputPath, size: 'mp4-video'.length };
      },
      streamAudioExtractor: async ({ outputPath }) => {
        await writeFile(outputPath, 'm4a-audio');
        return { outputPath, size: 'm4a-audio'.length };
      }
    }
  );
});

test('stored book videos can be queued for the separate video worker step', async () => {
  await withTestServer(async (baseUrl) => {
    const form = new FormData();
    form.set('requestId', 'video_req_worker_queue');
    form.set('video', new Blob(['queued-video'], { type: 'video/mp4' }), 'queued-session.mp4');

    const capture = await fetch(`${baseUrl}/webhooks/mentra/book-video`, {
      method: 'POST',
      body: form
    });
    const created = await capture.json();

    const queue = await fetch(`${baseUrl}/webhooks/mentra/book-page/${created.id}/process-video`, {
      method: 'POST'
    });
    assert.equal(queue.status, 202);
    const queued = await queue.json();
    assert.equal(queued.status, 'queued');
    assert.equal(queued.draft.processing.mode, 'queued');
    assert.equal(queued.draft.processing.reason, 'manual');

    const list = await fetch(`${baseUrl}/api/highlights`);
    const { highlights } = await list.json();
    assert.equal(highlights[0].draft.processing.mode, 'queued');
  });
});

test('video worker processes queued stored video drafts as a separate step', async () => {
  const telegramCalls = [];
  await withTestServer(async (baseUrl, { app, mediaDir }) => {
    const transcript = 'OpenClaw, remind me to ask how I can be useful today. Please create a daily review.';
    const form = new FormData();
    form.set('requestId', 'video_req_worker_process');
    form.set('transcript', transcript);
    form.set('video', new Blob(['worker-video'], { type: 'video/mp4' }), 'worker-session.mp4');

    const capture = await fetch(`${baseUrl}/webhooks/mentra/book-video`, {
      method: 'POST',
      body: form
    });
    const created = await capture.json();

    const queue = await fetch(`${baseUrl}/webhooks/mentra/book-page/${created.id}/process-video`, {
      method: 'POST'
    });
    assert.equal(queue.status, 202);

    const result = await processQueuedVideoDrafts({
      highlightStore: app.highlightStore,
      mediaDir,
      publicBaseUrl: baseUrl,
      telegramFetch: mockTelegramFetch(telegramCalls),
      frameExtractor: async ({ mediaDir: workerMediaDir, publicBaseUrl }) => {
        const filePath = path.join(workerMediaDir, 'worker_frame_test.jpg');
        await writeFile(filePath, 'worker-frame');
        return [
          {
            filename: 'worker_frame_test.jpg',
            filePath,
            mimeType: 'image/jpeg',
            size: 4096,
            index: 0,
            url: `${publicBaseUrl}/media/worker_frame_test.jpg`
          }
        ];
      },
      frameScorer: async () => ({ provider: 'test_quality', sharpnessScore: 8 }),
      frameEnhancer: async ({ frame }) => frame,
      frameHighlightExtractor: async ({ filePath }) => {
        assert.match(filePath, /worker_frame_test\.jpg$/);
        return {
          provider: 'test',
          hasMarkedText: true,
          highlights: [
            {
              text: 'Worker extracted this page from the stored video.',
              page: '77',
              marker: 'underline',
              confidence: 0.91,
              title: 'Worker Book',
              author: 'Worker Author'
            }
          ]
        };
      }
    });
    assert.equal(result.processed, 1);
    assert.equal(result.failed, 0);

    const list = await fetch(`${baseUrl}/api/highlights`);
    const { highlights } = await list.json();
    assert.equal(highlights.length, 1);
    assert.equal(highlights[0].draft.processing.mode, 'processed');
    assert.equal(highlights[0].draft.processing.frameCount, 1);
    assert.equal(highlights[0].draft.processing.highlightCount, 1);
    assert.equal(highlights[0].draft.processing.bookIdentityStatus, 'confirmed');
    assert.equal(highlights[0].draft.metadata.bookIdentity.title, 'Worker Book');
    assert.equal(highlights[0].draft.metadata.bookIdentity.author, 'Worker Author');
    assert.equal(highlights[0].draft.highlight.text, 'Worker extracted this page from the stored video.');
    assert.equal(highlights[0].draft.highlight.note.includes(transcript), true);
    assert.match(highlights[0].draft.highlight.note, /Pen highlight p\. 77: Worker extracted this page from the stored video\./);
    assert.equal(highlights[0].draft.extractedHighlights[0].text, 'Worker extracted this page from the stored video.');
    assert.deepEqual(highlights[0].draft.frameUrls, [`${baseUrl}/media/worker_frame_test.jpg`]);
    const actionMessage = telegramCalls.find((call) => call.url.endsWith('/sendMessage') && /^OpenClaw action plan\b/.test(call.body.text));
    assert.ok(actionMessage);
    assert.match(actionMessage.body.text, /I will take 2 actions from your voice note/);
    assert.match(actionMessage.body.text, /remind me to ask how I can be useful today/);
    assert.match(actionMessage.body.text, /create a daily review/);
    const candidateMessage = telegramCalls.find((call) => call.url.endsWith('/sendMessage') && /^Readwise highlight review\b/.test(call.body.text));
    assert.ok(candidateMessage);
    assert.match(candidateMessage.body.text, /Source: Book pen/);
    assert.match(candidateMessage.body.text, /Book: Worker Book/);
    assert.match(candidateMessage.body.text, /Author: Worker Author/);
    assert.match(candidateMessage.body.text, /Worker extracted this page from the stored video/);
    assert.equal(candidateMessage.body.reply_markup.inline_keyboard[0][0].text, 'Approve Highlight');
    assert.match(candidateMessage.body.reply_markup.inline_keyboard[0][0].callback_data, /^rw:a:/);
    const noteMessage = telegramCalls.find((call) => call.url.endsWith('/sendMessage') && /^Voice thought review\b/.test(call.body.text));
    assert.ok(noteMessage);
    assert.match(noteMessage.body.text, /Source: Voice thought/);
    assert.equal(noteMessage.body.reply_markup.inline_keyboard[0][0].text, 'Keep Note');
    assert.equal(highlights[0].draft.metadata.telegramProcessed.actionMessageIds.length, 1);
    assert.equal(highlights[0].draft.metadata.telegramProcessed.candidateMessageIds.length, 2);
    assert.equal(highlights[0].draft.metadata.telegramProcessed.candidateTokens.length, 2);
  }, {
    telegramFetch: mockTelegramFetch(telegramCalls),
    env: {
      READWISE_VIDEO_HIGHLIGHT_OCR: '1',
      READWISE_VIDEO_AUDIO_TRANSCRIPTION: '0',
      READWISE_VIDEO_OCR_DEDUPE: '0'
    },
    telegramConfig: {
      READWISE_TELEGRAM_BOT_TOKEN: 'telegram-token',
      READWISE_TELEGRAM_CHAT_ID: 'telegram-chat'
    }
  });
});

test('video worker reuses active reading context when later clips miss book metadata', async () => {
  const telegramCalls = [];
  await withTestServer(async (baseUrl, { app, mediaDir }) => {
    let phase = 'seed';
    const captureQueuedVideo = async (requestId, content) => {
      const form = new FormData();
      form.set('requestId', requestId);
      form.set('video', new Blob([content], { type: 'video/mp4' }), `${requestId}.mp4`);

      const capture = await fetch(`${baseUrl}/webhooks/mentra/book-video`, {
        method: 'POST',
        body: form
      });
      const created = await capture.json();

      const queue = await fetch(`${baseUrl}/webhooks/mentra/book-page/${created.id}/process-video`, {
        method: 'POST'
      });
      assert.equal(queue.status, 202);
      return created;
    };

    const runWorker = () => processQueuedVideoDrafts({
      highlightStore: app.highlightStore,
      mediaDir,
      publicBaseUrl: baseUrl,
      telegramFetch: mockTelegramFetch(telegramCalls),
      frameExtractor: async ({ mediaDir: workerMediaDir, publicBaseUrl }) => {
        const filename = `${phase}_reading_context_frame.jpg`;
        const filePath = path.join(workerMediaDir, filename);
        await writeFile(filePath, `${phase}-frame`);
        return [{ filename, filePath, mimeType: 'image/jpeg', size: 4096, index: 0, url: `${publicBaseUrl}/media/${filename}` }];
      },
      frameScorer: async () => ({ provider: 'test_quality', sharpnessScore: 8 }),
      frameEnhancer: async ({ frame }) => frame,
      frameHighlightExtractor: async () => ({
        provider: 'test',
        hasMarkedText: true,
        highlights: phase === 'seed'
          ? [
              {
                text: 'Seed quote that identifies the active reading book.',
                page: '15',
                marker: 'underline',
                confidence: 0.92,
                title: 'Context Book',
                author: 'Context Author'
              }
            ]
          : [
              {
                text: 'Later quote that depends on active reading context.',
                page: '16',
                marker: 'underline',
                confidence: 0.9
              }
            ]
      })
    });

    await captureQueuedVideo('video_req_context_seed', 'seed-video');
    let result = await runWorker();
    assert.equal(result.processed, 1);

    phase = 'fallback';
    await captureQueuedVideo('video_req_context_fallback', 'fallback-video');
    result = await runWorker();
    assert.equal(result.processed, 1);

    const list = await fetch(`${baseUrl}/api/highlights`);
    const { highlights } = await list.json();
    const seed = highlights.find((entry) => entry.draft.metadata?.requestId === 'video_req_context_seed');
    const fallback = highlights.find((entry) => entry.draft.metadata?.requestId === 'video_req_context_fallback');

    assert.equal(seed.draft.metadata.bookIdentity.status, 'confirmed');
    assert.equal(seed.draft.metadata.bookIdentity.title, 'Context Book');
    assert.equal(seed.draft.metadata.bookIdentity.author, 'Context Author');
    assert.equal(fallback.draft.metadata.bookIdentity.status, 'context_fallback');
    assert.equal(fallback.draft.metadata.bookIdentity.source, 'reading_context');
    assert.equal(fallback.draft.metadata.bookIdentity.title, 'Context Book');
    assert.equal(fallback.draft.metadata.bookIdentity.author, 'Context Author');
    assert.equal(fallback.draft.processing.bookIdentityStatus, 'context_fallback');
    assert.equal(fallback.draft.processing.bookIdentitySource, 'reading_context');
    assert.equal(fallback.draft.highlight.title, 'Context Book');
    assert.equal(fallback.draft.readwisePayload.body.highlights[0].title, 'Context Book');
    assert.equal(fallback.draft.readwisePayload.body.highlights[0].author, 'Context Author');

    const fallbackCandidate = telegramCalls.find((call) =>
      call.url.endsWith('/sendMessage') && /Later quote that depends on active reading context/.test(call.body.text)
    );
    assert.ok(fallbackCandidate);
    assert.match(fallbackCandidate.body.text, /Book: Context Book/);
    assert.match(fallbackCandidate.body.text, /Author: Context Author/);
    assert.match(fallbackCandidate.body.text, /Book source: active reading context/);
    assert.doesNotMatch(fallbackCandidate.body.text, /approval blocked/);
  }, {
    telegramFetch: mockTelegramFetch(telegramCalls),
    env: {
      READWISE_VIDEO_HIGHLIGHT_OCR: '1',
      READWISE_VIDEO_AUDIO_TRANSCRIPTION: '0',
      READWISE_VIDEO_OCR_DEDUPE: '0'
    },
    telegramConfig: {
      READWISE_TELEGRAM_BOT_TOKEN: 'telegram-token',
      READWISE_TELEGRAM_CHAT_ID: 'telegram-chat'
    }
  });
});

test('video worker matches partial book OCR against reading history', async () => {
  const telegramCalls = [];
  await withTestServer(async (baseUrl, { app, mediaDir }) => {
    let phase = 'deep';
    const captureQueuedVideo = async (requestId) => {
      const form = new FormData();
      form.set('requestId', requestId);
      form.set('video', new Blob([`${requestId}-video`], { type: 'video/mp4' }), `${requestId}.mp4`);

      const capture = await fetch(`${baseUrl}/webhooks/mentra/book-video`, {
        method: 'POST',
        body: form
      });
      const created = await capture.json();

      const queue = await fetch(`${baseUrl}/webhooks/mentra/book-page/${created.id}/process-video`, {
        method: 'POST'
      });
      assert.equal(queue.status, 202);
      return created;
    };

    const processNext = () => processQueuedVideoDrafts({
      highlightStore: app.highlightStore,
      mediaDir,
      publicBaseUrl: baseUrl,
      telegramFetch: mockTelegramFetch(telegramCalls),
      videoProcessor: async () => {
        const identityByPhase = {
          deep: { title: 'Deep Work', author: 'Cal Newport', status: 'confirmed', source: 'vision_ocr' },
          atomic: { title: 'Atomic Habits', author: 'James Clear', status: 'confirmed', source: 'vision_ocr' },
          partial: { title: 'Deep Wor', status: 'missing', source: 'partial', required: true }
        };
        const highlightByPhase = {
          deep: 'Deep work seed quote.',
          atomic: 'Atomic habits seed quote.',
          partial: 'Partial OCR quote from the older book.'
        };
        const bookIdentity = identityByPhase[phase];
        const text = highlightByPhase[phase];
        return {
          ocrText: `${bookIdentity.title && bookIdentity.author ? `TITLE: ${bookIdentity.title}\nAUTHOR: ${bookIdentity.author}\n` : ''}[HIGHLIGHT] ${text}`,
          frameUrls: [`${baseUrl}/media/${phase}_history_frame.jpg`],
          extractedHighlights: [{ text, page: phase === 'partial' ? '42' : '1', marker: 'underline', confidence: 0.9 }],
          reviewNote: '',
          transcript: '',
          processing: {
            frameCount: 1,
            selectedFrameCount: 1,
            highlightCount: 1,
            bookIdentityStatus: bookIdentity.status,
            bookIdentitySource: bookIdentity.source
          },
          bookIdentity
        };
      }
    });

    await captureQueuedVideo('video_req_history_deep');
    assert.equal((await processNext()).processed, 1);

    phase = 'atomic';
    await captureQueuedVideo('video_req_history_atomic');
    assert.equal((await processNext()).processed, 1);

    phase = 'partial';
    await captureQueuedVideo('video_req_history_partial');
    assert.equal((await processNext()).processed, 1);

    const list = await fetch(`${baseUrl}/api/highlights`);
    const { highlights } = await list.json();
    const partial = highlights.find((entry) => entry.draft.metadata?.requestId === 'video_req_history_partial');

    assert.equal(partial.draft.metadata.bookIdentity.status, 'history_fallback');
    assert.equal(partial.draft.metadata.bookIdentity.source, 'reading_context_history');
    assert.equal(partial.draft.metadata.bookIdentity.title, 'Deep Work');
    assert.equal(partial.draft.metadata.bookIdentity.author, 'Cal Newport');
    assert.equal(partial.draft.processing.bookIdentityStatus, 'history_fallback');
    assert.equal(partial.draft.processing.bookIdentitySource, 'reading_context_history');
    assert.equal(partial.draft.readwisePayload.body.highlights[0].title, 'Deep Work');
    assert.equal(partial.draft.readwisePayload.body.highlights[0].author, 'Cal Newport');

    const historyCandidate = telegramCalls.find((call) =>
      call.url.endsWith('/sendMessage') && /Partial OCR quote from the older book/.test(call.body.text)
    );
    assert.ok(historyCandidate);
    assert.match(historyCandidate.body.text, /Book: Deep Work/);
    assert.match(historyCandidate.body.text, /Author: Cal Newport/);
    assert.match(historyCandidate.body.text, /Book source: reading history match/);
    assert.doesNotMatch(historyCandidate.body.text, /approval blocked/);
  }, {
    telegramFetch: mockTelegramFetch(telegramCalls),
    env: {
      READWISE_VIDEO_HIGHLIGHT_OCR: '1',
      READWISE_VIDEO_AUDIO_TRANSCRIPTION: '0',
      READWISE_VIDEO_OCR_DEDUPE: '0'
    },
    telegramConfig: {
      READWISE_TELEGRAM_BOT_TOKEN: 'telegram-token',
      READWISE_TELEGRAM_CHAT_ID: 'telegram-chat'
    }
  });
});

test('video worker blocks Readwise approval when book title and author are missing', async () => {
  const telegramCalls = [];
  await withTestServer(async (baseUrl, { app, mediaDir }) => {
    const form = new FormData();
    form.set('requestId', 'video_req_missing_book_identity');
    form.set('video', new Blob(['worker-video'], { type: 'video/mp4' }), 'worker-session.mp4');

    const capture = await fetch(`${baseUrl}/webhooks/mentra/book-video`, {
      method: 'POST',
      body: form
    });
    const created = await capture.json();

    const queue = await fetch(`${baseUrl}/webhooks/mentra/book-page/${created.id}/process-video`, {
      method: 'POST'
    });
    assert.equal(queue.status, 202);

    await processQueuedVideoDrafts({
      highlightStore: app.highlightStore,
      mediaDir,
      publicBaseUrl: baseUrl,
      telegramFetch: mockTelegramFetch(telegramCalls),
      frameExtractor: async ({ mediaDir: workerMediaDir, publicBaseUrl }) => {
        const filePath = path.join(workerMediaDir, 'missing_book_frame_test.jpg');
        await writeFile(filePath, 'worker-frame');
        return [{ filename: 'missing_book_frame_test.jpg', filePath, mimeType: 'image/jpeg', size: 4096, index: 0, url: `${publicBaseUrl}/media/missing_book_frame_test.jpg` }];
      },
      frameScorer: async () => ({ provider: 'test_quality', sharpnessScore: 8 }),
      frameEnhancer: async ({ frame }) => frame,
      frameHighlightExtractor: async () => ({
        provider: 'test',
        hasMarkedText: true,
        highlights: [
          {
            text: 'A quote that is readable but missing book metadata.',
            page: '10',
            marker: 'underline',
            confidence: 0.91
          }
        ]
      })
    });

    const list = await fetch(`${baseUrl}/api/highlights`);
    const { highlights } = await list.json();
    assert.equal(highlights[0].draft.processing.bookIdentityStatus, 'missing');
    assert.equal(highlights[0].draft.metadata.bookIdentity.required, true);

    const candidateMessage = telegramCalls.find((call) => call.url.endsWith('/sendMessage') && /^Readwise highlight review\b/.test(call.body.text));
    assert.ok(candidateMessage);
    assert.match(candidateMessage.body.text, /Book: missing title\/author - approval blocked/);
    const callbackData = candidateMessage.body.reply_markup.inline_keyboard[0][0].callback_data;

    const callback = await fetch(`${baseUrl}/webhooks/telegram/readwise`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-readwise-telegram-forward-token': 'forward-token'
      },
      body: JSON.stringify({
        callback_query: {
          id: 'callback-missing-book',
          data: callbackData,
          message: {
            chat: { id: 'telegram-chat' },
            message_id: 'telegram-message-candidate'
          }
        }
      })
    });
    assert.equal(callback.status, 200);
    assert.equal((await callback.json()).status, 'blocked_book_identity');
    const editCall = telegramCalls.find((call) => call.url.endsWith('/editMessageText') && /Book metadata required/.test(call.body.text));
    assert.ok(editCall);
  }, {
    telegramFetch: mockTelegramFetch(telegramCalls),
    env: {
      READWISE_VIDEO_HIGHLIGHT_OCR: '1',
      READWISE_VIDEO_AUDIO_TRANSCRIPTION: '0',
      READWISE_VIDEO_OCR_DEDUPE: '0',
      READWISE_TELEGRAM_FORWARD_TOKEN: 'forward-token'
    },
    telegramConfig: {
      READWISE_TELEGRAM_BOT_TOKEN: 'telegram-token',
      READWISE_TELEGRAM_CHAT_ID: 'telegram-chat'
    }
  });
});

test('multipart book videos can be sampled into frame OCR drafts when frame extraction is configured', async () => {
  await withTestServer(
    async (baseUrl) => {
      const form = new FormData();
      form.set('requestId', 'video_req_readwise_sdk');
      form.set('transcript', 'thinking about the book argument');
      form.set('video', new Blob(['fake-video'], { type: 'video/mp4' }), 'book-session.mp4');

      const capture = await fetch(`${baseUrl}/webhooks/mentra/book-video`, {
        method: 'POST',
        body: form
      });
      assert.equal(capture.status, 201);
      const created = await capture.json();
      assert.match(created.id, /^highlight_/);
      assert.equal(created.draft.sourceKind, 'book_video');
      assert.deepEqual(created.draft.metadata, { requestId: 'video_req_readwise_sdk' });
      assert.equal(created.draft.highlight.text, 'Video frame highlight for Readwise.');
      assert.equal(created.draft.highlight.note, 'thinking about the book argument');
      assert.match(created.draft.videoUrl, new RegExp(`^${baseUrl}/media/book_video_`));
      assert.deepEqual(created.draft.frameUrls, [`${baseUrl}/media/video_frame_test.jpg`]);
      assert.equal(created.draft.imageUrl, `${baseUrl}/media/video_frame_test.jpg`);

      const video = await fetch(created.draft.videoUrl);
      assert.equal(video.status, 200);
      assert.equal(await video.text(), 'fake-video');

      const frame = await fetch(created.draft.frameUrls[0]);
      assert.equal(frame.status, 200);
      assert.equal(await frame.text(), 'video-frame');

      const reject = await fetch(`${baseUrl}/webhooks/mentra/book-page/${created.id}/reject`, {
        method: 'POST'
      });
      assert.equal(reject.status, 200);
    },
    {
      ocrExtractor: async ({ filePath }) => {
        assert.match(filePath, /video_frame_test\.jpg$/);
        return {
          provider: 'test',
          text: `TITLE: Video Book
AUTHOR: Video Author
PAGE: 44
[HIGHLIGHT] Video frame highlight for Readwise.`
        };
      },
      videoFrameExtractor: async ({ mediaDir, publicBaseUrl }) => {
        const filePath = path.join(mediaDir, 'video_frame_test.jpg');
        await writeFile(filePath, 'video-frame');
        return [
          {
            filename: 'video_frame_test.jpg',
            filePath,
            mimeType: 'image/jpeg',
            url: `${publicBaseUrl}/media/video_frame_test.jpg`
          }
        ];
      }
    }
  );
});

test('book page webhook can require a bridge token', async () => {
  await withBridgeToken('bridge-secret', async () => {
    await withTestServer(async (baseUrl) => {
      const authDenied = await fetch(`${baseUrl}/api/bridge-auth-check`);
      assert.equal(authDenied.status, 401);
      assert.deepEqual(await authDenied.json(), { error: 'unauthorized' });

      const unauthorized = await fetch(`${baseUrl}/webhooks/mentra/book-page`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ocrText: SAMPLE_OCR })
      });
      assert.equal(unauthorized.status, 401);
      assert.deepEqual(await unauthorized.json(), { error: 'unauthorized' });

      const unauthorizedVideo = await fetch(`${baseUrl}/webhooks/mentra/book-video`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mediaBase64: Buffer.from('video').toString('base64'), mediaMimeType: 'video/mp4' })
      });
      assert.equal(unauthorizedVideo.status, 401);
      assert.deepEqual(await unauthorizedVideo.json(), { error: 'unauthorized' });

      const review = await fetch(`${baseUrl}/review`, { headers: { accept: 'text/html' } });
      assert.equal(review.status, 200);
      assert.match(await review.text(), /name="bridgeToken"/);

      const formCapture = await fetch(`${baseUrl}/webhooks/mentra/book-page`, {
        method: 'POST',
        headers: {
          accept: 'text/html',
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          bridgeToken: 'bridge-secret',
          ocrText: '[HIGHLIGHT] Browser Readwise form token accepted.'
        }),
        redirect: 'manual'
      });
      assert.equal(formCapture.status, 302);
      assert.match(formCapture.headers.get('location'), /\/review\?status=drafted$/);

      const formDrafts = await fetch(`${baseUrl}/api/highlights`);
      const formDraft = (await formDrafts.json()).highlights.find((entry) =>
        entry.draft?.highlight?.text === 'Browser Readwise form token accepted.'
      );
      assert.ok(formDraft);

      const capture = await fetch(`${baseUrl}/webhooks/mentra/book-page`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mentra-bridge-token': 'bridge-secret'
        },
        body: JSON.stringify({ ocrText: SAMPLE_OCR, imageUrl: 'https://example.com/page.jpg' })
      });
      assert.equal(capture.status, 201);
      const created = await capture.json();
      assert.match(created.id, /^highlight_/);

      const authCheck = await fetch(`${baseUrl}/api/bridge-auth-check`, {
        headers: { 'x-mentra-bridge-token': 'bridge-secret' }
      });
      assert.equal(authCheck.status, 200);
      assert.deepEqual(await authCheck.json(), {
        ok: true,
        app: 'com.alerio.mentra.bookreadwise.test',
        bridgeAuthRequired: true
      });

      const reject = await fetch(`${baseUrl}/webhooks/mentra/book-page/${created.id}/reject`, {
        method: 'POST'
      });
      assert.equal(reject.status, 200);

      const rejectFormDraft = await fetch(`${baseUrl}/webhooks/mentra/book-page/${formDraft.id}/reject`, {
        method: 'POST'
      });
      assert.equal(rejectFormDraft.status, 200);
    });
  });
});

test('highlight store reloads pending approvals from disk', async () => {
  await withTestServer(async (baseUrl, context) => {
    const capture = await fetch(`${baseUrl}/webhooks/mentra/book-page`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ocrText: SAMPLE_OCR, imageUrl: 'https://example.com/page.jpg' })
    });
    assert.equal(capture.status, 201);

    const reloadedApp = new MentraBookReadwiseApp({
      packageName: 'com.alerio.mentra.bookreadwise.test',
      apiKey: 'test',
      healthCheck: false,
      highlightStorePath: context.highlightStorePath,
      mediaDir: context.mediaDir,
      ocrExtractor: async () => ({ provider: 'test', text: SAMPLE_OCR })
    });
    const highlights = await requestWithApp(reloadedApp, '/api/highlights');
    assert.equal(highlights.status, 200);
    const body = await highlights.json();
    assert.equal(body.highlights.length, 1);
    assert.equal(body.highlights[0].draft.highlight.text, 'Keep real page captures approval-gated.');
  });
});

test('session page capture requests Mentra camera and queues a Readwise approval draft', async () => {
  await withTestServer(async (baseUrl, context) => {
    const spoken = [];
    const shown = [];
    const session = {
      camera: {
        requestPhoto: async (options) => {
          assert.deepEqual(options, {
            saveToGallery: false,
            size: 'large',
            compress: 'medium'
          });
          return {
            buffer: Buffer.from('captured-page'),
            mimeType: 'image/jpeg',
            filename: 'captured-page.jpg',
            requestId: 'photo_req_page_session',
            size: 13,
            timestamp: new Date()
          };
        }
      },
      audio: {
        speak: (message) => spoken.push(message)
      },
      layouts: {
        showTextWall: (message) => shown.push(message)
      }
    };

    await context.app.captureBookPage({
      session,
      sessionId: 'book-session-1',
      transcript: 'capture page chapter one quote'
    });

    const list = await fetch(`${baseUrl}/api/highlights`);
    const { highlights } = await list.json();
    assert.equal(highlights.length, 1);
    assert.match(highlights[0].draft.imageUrl, new RegExp(`^${baseUrl}/media/book_page_`));
    assert.equal(highlights[0].draft.highlight.text, 'Keep real page captures approval-gated.');
    assert.equal(highlights[0].draft.ocr.title, 'Test Book');
    assert.ok(spoken.some((message) => message.includes('Page captured')));
    assert.ok(shown.some((message) => message.includes('Book page pending review')));

    const photo = await fetch(highlights[0].draft.imageUrl);
    assert.equal(photo.status, 200);
    assert.equal(await photo.text(), 'captured-page');
  });
});

async function withTestServer(callback, options = {}) {
  const previousLiveWrites = process.env.READWISE_LIVE_WRITES;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousPublicUrl = process.env.PUBLIC_URL;
  const previousPublicPath = process.env.PUBLIC_PATH;
  const previousBridgeToken = process.env.MENTRA_BRIDGE_TOKEN;
  const previousVideoFrameExtraction = process.env.READWISE_VIDEO_FRAME_EXTRACTION;
  const previousRtmpIngestEnabled = process.env.READWISE_RTMP_INGEST_ENABLED;
  const previousReadwiseTelegramBotToken = process.env.READWISE_TELEGRAM_BOT_TOKEN;
  const previousReadwiseTelegramChatId = process.env.READWISE_TELEGRAM_CHAT_ID;
  const isolatedEnvNames = [
    'MEDIA_DIR',
    'HIGHLIGHT_STORE_PATH',
    'READWISE_STREAM_WIDTH',
    'READWISE_STREAM_HEIGHT',
    'READWISE_STREAM_FRAME_RATE',
    'READWISE_STREAM_VIDEO_BITRATE',
    'READWISE_STREAM_AUDIO_CAPTURE',
    'READWISE_STREAM_AUDIO_BITRATE',
    'READWISE_STREAM_AUDIO_SAMPLE_RATE',
    'READWISE_STREAM_MAX_SECONDS',
    'READWISE_VIDEO_STREAM_CAPTURE',
    'READWISE_RTMP_INGEST_SECRET',
    'READWISE_RTMP_PUBLIC_HOST',
    'READWISE_RTMP_INGEST_PORT',
    'READWISE_RTMP_RECORD_DIR',
    'READWISE_RTMP_FALLBACK_RECORDING_READY_INTERVAL_MS',
    'READWISE_RTMP_FALLBACK_RECORDING_STABLE_MS',
    'READWISE_VIDEO_HIGHLIGHT_OCR',
    'READWISE_VIDEO_AUDIO_TRANSCRIPTION',
    'READWISE_VIDEO_OCR_DEDUPE',
    'READWISE_VIDEO_HIGHLIGHT_OCR_PROVIDER',
    'READWISE_READING_CONTEXT_PATH',
    'READWISE_APPROVAL_ENABLED',
    'READWISE_TELEGRAM_ENABLED',
    'READWISE_TELEGRAM_FORWARD_TOKEN',
    'READWISE_TELEGRAM_GENERATED_NOTES',
    'READWISE_TELEGRAM_OPENCLAW_ACTIONS',
    'READWISE_REVIEW_TOKEN',
    'ALERIO_REVIEW_TOKEN',
    'REVIEW_TOKEN',
    'READWISE_TOKEN',
    'READWISE_MEDIA_TOKEN_SECRET',
    'READWISE_REVIEW_LINK_SECRET',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY'
  ];
  const previousIsolatedEnv = new Map(isolatedEnvNames.map((name) => [name, process.env[name]]));
  const previousEnv = new Map(Object.keys(options.env || {}).map((name) => [name, process.env[name]]));
  process.env.NODE_ENV = 'test';
  process.env.READWISE_LIVE_WRITES = '0';
  process.env.PUBLIC_PATH = '';
  process.env.READWISE_RTMP_INGEST_ENABLED = '0';
  delete process.env.READWISE_VIDEO_FRAME_EXTRACTION;
  delete process.env.READWISE_TELEGRAM_BOT_TOKEN;
  delete process.env.READWISE_TELEGRAM_CHAT_ID;
  for (const name of isolatedEnvNames) {
    delete process.env[name];
  }
  if (process.env.TEST_ALLOW_BRIDGE_TOKEN !== '1') delete process.env.MENTRA_BRIDGE_TOKEN;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'mentra-readwise-test-'));
  const mediaDir = path.join(tempDir, 'media');
  const highlightStorePath = path.join(tempDir, 'pending-highlights.json');
  const readingContextStorePath = path.join(tempDir, 'reading-context.json');
  process.env.READWISE_READING_CONTEXT_PATH = readingContextStorePath;
  for (const [name, value] of Object.entries(options.env || {})) {
    process.env[name] = typeof value === 'function' ? value({ tempDir, mediaDir, highlightStorePath, readingContextStorePath }) : value;
  }
  for (const [name, value] of Object.entries(options.telegramConfig || {})) {
    process.env[name] = value;
  }
  const app = new MentraBookReadwiseApp({
    packageName: 'com.alerio.mentra.bookreadwise.test',
    apiKey: 'test',
    healthCheck: false,
    highlightStorePath,
    mediaDir,
    ocrExtractor: options.ocrExtractor || (async () => ({ provider: 'test', text: SAMPLE_OCR })),
    ...(options.videoFrameExtractor ? { videoFrameExtractor: options.videoFrameExtractor } : {}),
    ...(options.telegramFetch ? { telegramFetch: options.telegramFetch } : {}),
    ...(options.streamRemuxer ? { streamRemuxer: options.streamRemuxer } : {}),
    ...(options.streamAudioExtractor ? { streamAudioExtractor: options.streamAudioExtractor } : {}),
    ...(options.rtmpIngestServerFactory ? { rtmpIngestServerFactory: options.rtmpIngestServerFactory } : {})
  });
  const server = createServer(app.getExpressApp());

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.PUBLIC_URL = baseUrl;

  try {
    await callback(baseUrl, { app, tempDir, mediaDir, highlightStorePath, readingContextStorePath });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(tempDir, { recursive: true, force: true });
    pendingEnvRestore(previousLiveWrites);
    restoreEnv('NODE_ENV', previousNodeEnv);
    if (previousPublicUrl === undefined) {
      delete process.env.PUBLIC_URL;
    } else {
      process.env.PUBLIC_URL = previousPublicUrl;
    }
    restoreEnv('PUBLIC_PATH', previousPublicPath);
    restoreEnv('MENTRA_BRIDGE_TOKEN', previousBridgeToken);
    restoreEnv('READWISE_VIDEO_FRAME_EXTRACTION', previousVideoFrameExtraction);
    restoreEnv('READWISE_RTMP_INGEST_ENABLED', previousRtmpIngestEnabled);
    restoreEnv('READWISE_TELEGRAM_BOT_TOKEN', previousReadwiseTelegramBotToken);
    restoreEnv('READWISE_TELEGRAM_CHAT_ID', previousReadwiseTelegramChatId);
    for (const [name, value] of previousIsolatedEnv) {
      restoreEnv(name, value);
    }
    for (const [name, value] of previousEnv) {
      restoreEnv(name, value);
    }
  }
}

async function requestWithApp(app, pathName) {
  const server = createServer(app.getExpressApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  try {
    return await fetch(`http://127.0.0.1:${address.port}${pathName}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function waitForHighlights(baseUrl, expectedCount, { timeoutMs = 500, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];

  while (Date.now() <= deadline) {
    const list = await fetch(`${baseUrl}/api/highlights`);
    const body = await list.json();
    latest = body.highlights || [];
    if (latest.length >= expectedCount) return latest;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  assert.fail(`Timed out waiting for ${expectedCount} highlight(s); saw ${latest.length}`);
}

function pendingEnvRestore(previousLiveWrites) {
  if (previousLiveWrites === undefined) {
    delete process.env.READWISE_LIVE_WRITES;
  } else {
    process.env.READWISE_LIVE_WRITES = previousLiveWrites;
  }
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function withBridgeToken(value, callback) {
  const previousToken = process.env.MENTRA_BRIDGE_TOKEN;
  const previousAllow = process.env.TEST_ALLOW_BRIDGE_TOKEN;
  process.env.MENTRA_BRIDGE_TOKEN = value;
  process.env.TEST_ALLOW_BRIDGE_TOKEN = '1';
  try {
    await callback();
  } finally {
    restoreEnv('MENTRA_BRIDGE_TOKEN', previousToken);
    restoreEnv('TEST_ALLOW_BRIDGE_TOKEN', previousAllow);
  }
}

function mockTelegramFetch(calls = []) {
  return async (url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    calls.push({ url, body });
    return Response.json({
      ok: true,
      result: {
        message_id: `telegram-message-${calls.length}`,
        chat: { id: body.chat_id }
      }
    });
  };
}
