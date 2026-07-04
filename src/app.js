import 'dotenv/config';
import { AppServer } from '@mentra/sdk';
import NodeMediaServer from 'node-media-server';
import express from 'express';
import multer from 'multer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { buildApprovalDraft, sendReadwiseHighlight } from './domain.js';
import { extractBookTextWithOpenClaw } from './ocr.js';
import { extractAudioToM4a, remuxRecordingToMp4 } from './stream-recorder.js';

const APP_NAME = 'Alerio Readwise';
const DEFAULT_PACKAGE_NAME = 'com.alerio.mentra.bookreadwise';
const REVIEW_COOKIE_NAME = 'alerio_readwise_review';

class LocalMediaStore {
  constructor(dir = process.env.MEDIA_DIR || path.join(process.cwd(), 'data', 'media')) {
    this.dir = dir;
  }

  async savePhoto(photo, { publicBaseUrl, label = 'book_page' } = {}) {
    return this.saveBuffer(photo.buffer, {
      originalName: photo.filename,
      mimeType: photo.mimeType,
      publicBaseUrl,
      label
    });
  }

  async saveBuffer(buffer, { originalName = 'page.jpg', mimeType = 'image/jpeg', publicBaseUrl, label = 'book_page' } = {}) {
    const extension = extensionForMime(mimeType) || extensionForFilename(originalName) || '.jpg';
    const filename = `${label}_${Date.now()}_${randomUUID()}${extension}`;
    const filePath = path.join(this.dir, filename);

    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(filePath, buffer);

    return {
      filename,
      filePath,
      mimeType,
      size: buffer.length,
      url: publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/media/${encodeURIComponent(filename)}` : null
    };
  }

  async allocateFile({ originalName = 'capture.bin', mimeType = 'application/octet-stream', publicBaseUrl, label = 'capture' } = {}) {
    const extension = extensionForMime(mimeType) || extensionForFilename(originalName) || '.bin';
    const filename = `${label}_${Date.now()}_${randomUUID()}${extension}`;
    const filePath = path.join(this.dir, filename);

    await fs.mkdir(this.dir, { recursive: true });

    return {
      filename,
      filePath,
      mimeType,
      size: 0,
      url: publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/media/${encodeURIComponent(filename)}` : null
    };
  }

  resolveFilename(filename = '') {
    const safeFilename = sanitizeMediaFilename(filename);
    if (!safeFilename) return null;

    const root = path.resolve(this.dir);
    const filePath = path.resolve(root, safeFilename);
    if (!filePath.startsWith(`${root}${path.sep}`)) return null;

    return {
      filename: safeFilename,
      filePath,
      mimeType: mimeTypeForFilename(safeFilename) || 'application/octet-stream'
    };
  }

  async statMedia(media = {}) {
    const stat = await fs.stat(media.filePath);
    return {
      ...media,
      size: stat.size,
      createdAt: new Date(mediaCreatedAtMs(media.filename, stat)).toISOString(),
      updatedAt: stat.mtime.toISOString()
    };
  }

  async list({ publicBaseUrl } = {}) {
    await fs.mkdir(this.dir, { recursive: true });
    const filenames = await fs.readdir(this.dir);
    const entries = await Promise.all(
      filenames.map(async (filename) => {
        const filePath = path.join(this.dir, filename);
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) return null;
        return {
          filename,
          kind: mediaKindForFilename(filename),
          mimeType: mimeTypeForFilename(filename) || 'application/octet-stream',
          size: stat.size,
          createdAt: stat.birthtime.toISOString(),
          updatedAt: stat.mtime.toISOString(),
          url: publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/media/${encodeURIComponent(filename)}` : null
        };
      })
    );
    return entries.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

class FileHighlightStore {
  constructor(filePath = process.env.HIGHLIGHT_STORE_PATH || path.join(process.cwd(), 'data', 'pending-highlights.json')) {
    this.filePath = filePath;
    this.highlights = new Map();
    this.loaded = false;
  }

  async list() {
    await this.load();
    return Array.from(this.highlights.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id) {
    await this.load();
    return this.highlights.get(id) || null;
  }

  async set(id, draft) {
    await this.load();
    const existing = this.highlights.get(id);
    const entry = {
      id,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      draft
    };
    this.highlights.set(id, entry);
    await this.persist();
    return entry;
  }

  async create(draft) {
    return this.set(`highlight_${Date.now()}_${randomUUID()}`, draft);
  }

  async delete(id) {
    await this.load();
    const existed = this.highlights.delete(id);
    if (existed) await this.persist();
    return existed;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      for (const entry of parsed.highlights || []) {
        if (entry?.id && entry?.draft) this.highlights.set(entry.id, entry);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async persist() {
    const dir = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    const payload = {
      highlights: Array.from(this.highlights.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    };

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
    await fs.rename(tempPath, this.filePath);
  }
}

class FileReadingContextStore {
  constructor(filePath = process.env.READWISE_READING_CONTEXT_PATH || path.join(process.cwd(), 'data', 'reading-context.json')) {
    this.filePath = filePath;
    this.state = null;
  }

  async getActiveBook() {
    await this.load();
    return normalizeReadingContextBook(this.state.activeBook);
  }

  async listBooks() {
    await this.load();
    return (Array.isArray(this.state.books) ? this.state.books : [])
      .map(normalizeReadingContextBook)
      .filter(Boolean)
      .sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
  }

  async setActiveBook(identity = {}, { draftId = '', page = '' } = {}) {
    await this.load();
    const title = normalizeBookIdentityField(identity.title);
    const author = normalizeBookIdentityField(identity.author);
    if (!title || !author) return null;

    const now = new Date().toISOString();
    const books = Array.isArray(this.state.books) ? this.state.books.map(normalizeReadingContextBook).filter(Boolean) : [];
    const existing = books.find((book) => sameReadingContextBook(book, { title, author }));
    const nextSource = normalizeBookIdentityField(identity.source);
    const pages = uniqueStrings([...(existing?.pages || []), page ? normalizeNoteText(page).slice(0, 40) : '']).slice(-50);
    const recentDraftIds = uniqueStrings([
      ...(existing?.recentDraftIds || []),
      draftId ? normalizeNoteText(draftId).slice(0, 160) : ''
    ]).slice(-20);
    const activeBook = {
      ...(existing || {}),
      title,
      author,
      status: 'active',
      source: nextSource.startsWith('reading_context') && existing?.source ? existing.source : nextSource || existing?.source || 'detected',
      firstSeenAt: existing?.firstSeenAt || now,
      lastSeenAt: now,
      seenCount: Math.max(0, Number(existing?.seenCount) || 0) + 1,
      ...(pages.length ? { pages } : {}),
      ...(recentDraftIds.length ? { recentDraftIds } : {}),
      ...(draftId ? { lastDraftId: normalizeNoteText(draftId).slice(0, 160) } : {}),
      ...(page ? { lastPage: normalizeNoteText(page).slice(0, 40) } : {})
    };

    this.state = {
      activeBook,
      books: [
        activeBook,
        ...books.filter((book) => !sameReadingContextBook(book, activeBook))
      ].slice(0, 50)
    };
    await this.persist();
    return activeBook;
  }

  async load() {
    if (this.state) return;

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = {
        activeBook: normalizeReadingContextBook(parsed.activeBook),
        books: Array.isArray(parsed.books) ? parsed.books.map(normalizeReadingContextBook).filter(Boolean) : []
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = { activeBook: null, books: [] };
    }
  }

  async persist() {
    const dir = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`);
    await fs.rename(tempPath, this.filePath);
  }
}

class MentraBookReadwiseApp extends AppServer {
  constructor(config) {
    super(config);
    this.packageName = config.packageName || DEFAULT_PACKAGE_NAME;
    this.mediaStore = config.mediaStore || new LocalMediaStore(config.mediaDir);
    this.highlightStore = config.highlightStore || new FileHighlightStore(config.highlightStorePath);
    this.ocrExtractor = config.ocrExtractor || extractBookTextWithOpenClaw;
    this.videoFrameExtractor = config.videoFrameExtractor || null;
    this.streamRemuxer = config.streamRemuxer || remuxRecordingToMp4;
    this.streamAudioExtractor = config.streamAudioExtractor || extractAudioToM4a;
    this.rtmpIngestServerFactory = config.rtmpIngestServerFactory || ((rtmpConfig) => new NodeMediaServer(rtmpConfig));
    this.telegramFetch = config.telegramFetch || fetch;
    this.sessionStatus = new Map();
    this.videoStreamSessions = new Map();
    this.streamRecordings = new Map();
    this.rtmpRecordingsByStreamName = new Map();
    this.rtmpIngestServer = null;
    this.rtmpIngestSecret = '';
    this.configureRoutes();
    this.startRtmpIngestServer();
  }

  configureRoutes() {
    const app = this.getExpressApp();
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: getUploadLimitBytes()
      }
    });
    app.use(express.json({ limit: getExpressBodyLimit() }));
    app.use(express.urlencoded({ extended: false, limit: getExpressBodyLimit() }));
    app.post('/webhooks/telegram/readwise', requireReadwiseTelegramForwardAccess, async (request, response, next) => {
      try {
        const result = await this.handleReadwiseTelegramUpdate(request.body);
        response.json({ ok: true, ...result });
      } catch (error) {
        next(error);
      }
    });
    app.get('/media/private/:filename', requirePrivateMediaAccess, (request, response, next) => {
      const media = this.mediaStore.resolveFilename(request.params.filename);
      if (!media) {
        response.status(404).type('text/plain').send('Not found');
        return;
      }

      response.set('Cache-Control', 'private, no-store');
      const mimeType = media.mimeType || 'application/octet-stream';
      if (mimeType) response.type(mimeType);
      response.sendFile(media.filePath, (error) => {
        if (error) next(error);
      });
    });
    app.use('/media', express.static(this.mediaStore.dir, { dotfiles: 'deny', index: false, maxAge: '1h' }));
    app.use('/assets', express.static(path.join(process.cwd(), 'public'), { dotfiles: 'deny', index: false, maxAge: '1h' }));

    app.get('/', (request, response) => {
      response.json({
        app: 'com.alerio.mentra.bookreadwise',
        status: 'ready',
        mode: process.env.READWISE_LIVE_WRITES === '1' ? 'live_readwise' : 'dry_run',
        logoUrl: getPublicAssetUrl(request, 'app-icon.png'),
        endpoints: [
          '/.well-known/mentra-app.json',
          '/health',
          '/review',
          '/api/highlights',
          '/api/media',
          '/webhooks/mentra/book-video',
          'glasses button: start/stop direct RTMP video recording'
        ]
      });
    });

    app.get('/favicon.ico', (request, response) => {
      response.redirect(302, `${getBasePath(request)}/assets/app-icon.svg`);
    });

    app.get('/.well-known/mentra-app.json', (request, response) => {
      response.json(
        buildPublishManifest(request, {
          name: APP_NAME,
          packageName: this.packageName,
          description: 'Mentra glasses video recorder that stores reading video and audio for a separate frame/transcription worker.',
          reviewPath: '/review',
          queuePath: '/api/highlights',
          writeMode: process.env.READWISE_LIVE_WRITES === '1' ? 'live_readwise' : 'dry_run',
          writeModeDescription: 'Approvals write Readwise highlights only when READWISE_LIVE_WRITES=1.',
          captureEndpoints: ['/webhooks/mentra/book-video'],
          approvalGate: 'Recorded video and audio are stored first; downstream processing and Readwise import are separate steps.',
          streamMode: getVideoStreamRuntimeMode()
        })
      );
    });

    app.get('/review', requireReviewAccess, async (request, response, next) => {
      try {
        response.type('html').send(
          renderReviewPage({
            basePath: getBasePath(request),
            entries: await this.highlightStore.list(),
            status: request.query.status,
            error: request.query.error
          })
        );
      } catch (error) {
        next(error);
      }
    });

    app.get('/api/highlights', requireReviewAccess, async (_request, response, next) => {
      try {
        response.json({ highlights: await this.highlightStore.list() });
      } catch (error) {
        next(error);
      }
    });

    app.get('/api/media', requireReviewAccess, async (request, response, next) => {
      try {
        const media = typeof this.mediaStore.list === 'function' ? await this.mediaStore.list({ publicBaseUrl: getPublicUrl(request) }) : [];
        response.json({ media });
      } catch (error) {
        next(error);
      }
    });

    app.get('/api/sessions', requireReviewAccess, (_request, response) => {
      response.json({ sessions: Array.from(this.sessionStatus.values()) });
    });

    app.get('/api/bridge-auth-check', requireBridgeToken, (_request, response) => {
      response.json({
        ok: true,
        app: this.packageName,
        bridgeAuthRequired: Boolean(process.env.MENTRA_BRIDGE_TOKEN)
      });
    });

    app.post(
      '/webhooks/mentra/book-page',
      requireBridgeToken,
      upload.fields([
        { name: 'photo', maxCount: 1 },
        { name: 'file', maxCount: 1 },
        { name: 'image', maxCount: 1 }
      ]),
      async (request, response, next) => {
        try {
          const media = await this.resolveUploadedImage(request, { label: 'book_page' });
          const ocrText =
            request.body?.ocrText ||
            (media?.filePath
              ? await this.extractPageText({
                  filePath: media.filePath,
                  transcript: request.body?.transcript
                })
              : '');
          const draft = buildApprovalDraft({
            ocrText,
            imageUrl: media?.url || request.body?.imageUrl,
            ...extractTraceMetadata(request, 'book_page')
          });
          const entry = await this.notifyTelegramDraft(await this.highlightStore.create(draft), {
            reviewUrl: getPublicUrl(request, '/review')
          });
          if (isHtmlRequest(request)) {
            response.redirect(`${getBasePath(request)}/review?status=drafted`);
            return;
          }
          response.status(201).json({ id: entry.id, draft: entry.draft });
        } catch (error) {
          next(error);
        }
      }
    );

    app.post(
      '/webhooks/mentra/book-video',
      requireBridgeToken,
      upload.fields([
        { name: 'video', maxCount: 1 },
        { name: 'file', maxCount: 1 }
      ]),
      async (request, response, next) => {
        try {
          const media = await this.resolveUploadedVideo(request, { label: 'book_video' });
          const frames = media?.filePath && this.videoFrameExtractor
            ? await this.videoFrameExtractor({
                videoPath: media.filePath,
                mediaDir: this.mediaStore.dir,
                publicBaseUrl: process.env.PUBLIC_URL,
                label: 'book_frame'
              })
            : [];
          const ocrText =
            request.body?.ocrText ||
            (frames.length
              ? await this.extractVideoText({
                  frames,
                  transcript: request.body?.transcript
                })
              : buildStoredVideoReviewOcrText(request.body?.transcript));
          const frameUrls = frames.map((frame) => frame.url).filter(Boolean);
          const draft = buildApprovalDraft({
            ocrText,
            imageUrl: frameUrls[0] || '',
            videoUrl: media?.url || request.body?.videoUrl || '',
            frameUrls,
            sourceKind: 'book_video',
            storage: media,
            processing: {
              mode: frames.length ? 'frame_ocr' : 'stored_only',
              frameCount: frames.length,
              reason: frames.length ? '' : 'deferred'
            },
            ...extractTraceMetadata(request, 'book_video')
          });
          const entry = await this.notifyTelegramDraft(await this.highlightStore.create(draft), {
            reviewUrl: getPublicUrl(request, '/review')
          });
          if (isHtmlRequest(request)) {
            response.redirect(`${getBasePath(request)}/review?status=drafted`);
            return;
          }
          response.status(201).json({ id: entry.id, draft: entry.draft });
        } catch (error) {
          next(error);
        }
      }
    );

    app.post('/webhooks/mentra/book-page/:id/approve', requireReviewAccess, async (request, response, next) => {
      try {
        const entry = await this.highlightStore.get(request.params.id);
        if (!entry) return response.status(404).json({ error: 'not_found' });

        const result = await sendReadwiseHighlight({
          payload: entry.draft.readwisePayload,
          token: process.env.READWISE_TOKEN,
          liveWrites: process.env.READWISE_LIVE_WRITES === '1'
        });
        await this.highlightStore.delete(request.params.id);
        if (isHtmlRequest(request)) {
          response.redirect(`${getBasePath(request)}/review?status=approved`);
          return;
        }
        response.json({ status: 'approved', result });
      } catch (error) {
        next(error);
      }
    });

    app.post('/webhooks/mentra/book-page/:id/reject', requireReviewAccess, async (request, response, next) => {
      try {
        const existed = await this.highlightStore.delete(request.params.id);
        if (!existed) return response.status(404).json({ error: 'not_found' });
        if (isHtmlRequest(request)) {
          response.redirect(`${getBasePath(request)}/review?status=rejected`);
          return;
        }
        response.json({ status: 'rejected' });
      } catch (error) {
        next(error);
      }
    });

    app.post('/webhooks/mentra/book-page/:id/process-video', requireReviewAccess, async (request, response, next) => {
      try {
        const entry = await this.highlightStore.get(request.params.id);
        if (!entry) return response.status(404).json({ error: 'not_found' });
        if (entry.draft.sourceKind !== 'book_video') return response.status(400).json({ error: 'not_video_draft' });

        const queued = await this.highlightStore.set(request.params.id, {
          ...entry.draft,
          processing: {
            mode: 'queued',
            frameCount: entry.draft.processing?.frameCount || 0,
            reason: 'manual'
          }
        });

        if (isHtmlRequest(request)) {
          response.redirect(`${getBasePath(request)}/review?status=queued`);
          return;
        }
        response.status(202).json({ status: 'queued', id: queued.id, draft: queued.draft });
      } catch (error) {
        next(error);
      }
    });
  }

  async onSession(session, sessionId, userId) {
    this.sessionStatus.set(sessionId, {
      sessionId,
      userId: userId || session.userId || null,
      status: 'active',
      startedAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString(),
      lastEvent: 'session_started'
    });
    session.layouts?.showTextWall?.('Alerio Readwise recorder ready.');
    session.camera?.onStreamStatus?.((status) => {
      this.handleDirectRtmpStreamStatus({ sessionId, status });
    });
    session.events?.onButtonPress?.(async (event) => {
      this.noteSessionEvent(sessionId, 'button_press', {
        buttonEvent: normalizeButtonEventType(event) || 'unknown'
      });
      await this.toggleDirectRtmpVideoStream({ session, sessionId, reviewUrl: getPrivateReviewAppUrl('/review'), reason: 'button', buttonEvent: event });
    });
  }

  async onStop(sessionId, userId, reason) {
    await this.stopStreamRecording({ sessionId, reason: reason || 'session_stop' });
    this.sessionStatus.set(sessionId, {
      ...(this.sessionStatus.get(sessionId) || { sessionId, userId: userId || null, startedAt: null }),
      status: 'stopped',
      stoppedAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString(),
      lastEvent: reason || 'stopped'
    });
  }

  noteSessionEvent(sessionId, event, details = {}) {
    const current = this.sessionStatus.get(sessionId) || { sessionId, startedAt: new Date().toISOString() };
    this.sessionStatus.set(sessionId, {
      ...current,
      lastEventAt: new Date().toISOString(),
      lastEvent: event,
      ...(details && Object.keys(details).length ? { details } : {})
    });
  }

  async captureBookPage({ session, sessionId, transcript }) {
    try {
      session.audio?.speak?.('Capturing the book page.');
      this.noteSessionEvent(sessionId, 'photo_requested');
      const photo = await session.camera.requestPhoto({
        saveToGallery: false,
        size: 'large',
        compress: 'medium'
      });
      const media = await this.mediaStore.savePhoto(photo, {
        publicBaseUrl: process.env.PUBLIC_URL,
        label: 'book_page'
      });
      const ocrText = await this.extractPageText({
        filePath: media.filePath,
        transcript
      });
      const draft = buildApprovalDraft({
        imageUrl: media.url,
        ocrText,
        requestId: photo?.requestId || ''
      });
      await this.notifyTelegramDraft(await this.highlightStore.create(draft), {
        reviewUrl: process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, '')}/review` : ''
      });
      this.noteSessionEvent(sessionId, 'page_draft_created');
      session.layouts?.showTextWall?.(`Book page pending review:\n${draft.highlight.text || 'Review captured image before approving.'}`);
      session.audio?.speak?.('Page captured. Review the extracted highlight on the phone before approving.');
    } catch (error) {
      this.noteSessionEvent(sessionId, 'photo_failed');
      session.audio?.speak?.('Book page capture failed. Try again from the phone.');
      session.layouts?.showTextWall?.(`Page capture failed: ${error.message || error}`);
    }
  }

  startRtmpIngestServer() {
    if (!isRtmpIngestEnabled() || this.rtmpIngestServer) return;

    const configuredSecret = String(process.env.READWISE_RTMP_INGEST_SECRET || '').trim();
    this.rtmpIngestSecret = configuredSecret || randomUUID();
    if (!configuredSecret) {
      console.warn('Readwise RTMP ingest is using an ephemeral secret. Set READWISE_RTMP_INGEST_SECRET for stable signed ingest URLs.');
    }

    const config = {
      bind: '0.0.0.0',
      auth: {
        play: true,
        publish: true,
        secret: this.rtmpIngestSecret
      },
      rtmp: {
        port: getRtmpIngestPort()
      },
      record: {
        path: getRtmpRecordDir()
      }
    };
    const server = this.rtmpIngestServerFactory(config);
    server.on?.('postPublish', (session) => this.handleRtmpPostPublish(session));
    server.on?.('doneRecord', (session) => {
      this.completeRtmpStreamRecording(session).catch((error) => {
        const streamName = String(session?.streamName || '');
        const streamSessionId = this.rtmpRecordingsByStreamName.get(streamName) || '';
        this.failStreamRecording({ sessionId: streamSessionId, error }).catch?.(() => null);
      });
    });
    server.run?.();
    this.rtmpIngestServer = server;
    console.info('Readwise RTMP ingest enabled', {
      port: getRtmpIngestPort(),
      recordDir: getRtmpRecordDir(),
      publishAuth: true,
      secretConfigured: Boolean(configuredSecret),
      signTtlSeconds: getRtmpIngestSignTtlSeconds()
    });
  }

  async prepareRtmpStreamRecording({ sessionId, state = {} } = {}) {
    if (!isRtmpIngestEnabled()) return null;

    const id = String(sessionId || '');
    if (!this.rtmpIngestServer) this.startRtmpIngestServer();
    if (!this.rtmpIngestServer) return null;

    const existing = this.streamRecordings.get(id);
    if (existing) return { recording: existing, destination: existing.rtmpDestination || null };

    const media = await this.mediaStore.allocateFile({
      originalName: 'mentra-reading-stream.mp4',
      mimeType: 'video/mp4',
      publicBaseUrl: getPrivateStreamMediaPublicBaseUrl(),
      label: getStreamRecordingLabel()
    });
    const audioMedia = await this.mediaStore.allocateFile({
      originalName: 'mentra-reading-stream.m4a',
      mimeType: 'audio/mp4',
      publicBaseUrl: getPrivateStreamMediaPublicBaseUrl(),
      label: `${getStreamRecordingLabel()}_audio`
    });
    const streamName = `s_${randomUUID().replace(/-/g, '')}`;
    const rtmpUrl = this.buildSignedRtmpIngestUrl(streamName);
    let resolveDone;
    let rejectDone;
    const done = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const destination = { url: rtmpUrl, name: 'Alerio Readwise recorder' };
    const recording = {
      id: randomUUID(),
      mode: 'direct_rtmp',
      sourceKind: 'book_video',
      sessionId: id,
      streamId: state.streamId || '',
      rtmpStreamName: streamName,
      rtmpDestination: destination,
      media,
      audioMedia,
      status: 'waiting_for_rtmp',
      startedAt: new Date().toISOString(),
      done,
      resolveDone,
      rejectDone
    };
    this.streamRecordings.set(id, recording);
    this.rtmpRecordingsByStreamName.set(streamName, id);
    done
      .then((result) => this.finishStreamRecording({ sessionId: id, result, reason: 'rtmp_record_done' }))
      .catch((error) => this.failStreamRecording({ sessionId: id, error }));

    this.videoStreamSessions.set(id, {
      ...(this.videoStreamSessions.get(id) || {}),
      recording: publicStreamRecording(recording),
      updatedAt: new Date().toISOString()
    });
    this.noteSessionEvent(id, 'video_stream_recording_waiting_for_rtmp', {
      videoRecordingStatus: 'waiting_for_rtmp'
    });
    return { recording, destination };
  }

  buildSignedRtmpIngestUrl(streamName) {
    const appName = getRtmpIngestAppName();
    const streamPath = `/${appName}/${streamName}`;
    const expiresAt = Math.floor(Date.now() / 1000) + getRtmpIngestSignTtlSeconds();
    const hash = createHash('md5')
      .update(`${streamPath}-${expiresAt}-${this.rtmpIngestSecret}`)
      .digest('hex');
    const host = getRtmpPublicHost();
    const port = getRtmpIngestPort();
    const portPart = port === 1935 ? '' : `:${port}`;
    return `rtmp://${host}${portPart}/${appName}/${streamName}?sign=${expiresAt}-${hash}`;
  }

  handleRtmpPostPublish(session = {}) {
    const streamName = String(session.streamName || '');
    const streamSessionId = this.rtmpRecordingsByStreamName.get(streamName);
    if (!streamSessionId) {
      session.close?.();
      console.warn('Rejected unknown Readwise RTMP publish', { streamName });
      return;
    }

    const recording = this.streamRecordings.get(streamSessionId);
    if (!recording) return;
    recording.status = 'recording';
    recording.rtmpSessionId = session.id || '';
    const state = this.videoStreamSessions.get(streamSessionId) || {};
    this.videoStreamSessions.set(streamSessionId, {
      ...state,
      recording: publicStreamRecording(recording),
      updatedAt: new Date().toISOString()
    });
    this.noteSessionEvent(streamSessionId, 'video_stream_recording_started', {
      videoRecordingStatus: 'recording'
    });
  }

  async completeRtmpStreamRecording(session = {}) {
    const streamName = String(session.streamName || '');
    const sessionId = this.rtmpRecordingsByStreamName.get(streamName);
    if (!sessionId) return null;

    const result = await this.finalizeRtmpStreamRecording({
      sessionId,
      streamName,
      rawFilePath: session.filePath || '',
      reason: 'done_record'
    });
    return this.finishStreamRecording({ sessionId, result, reason: 'done_record' });
  }

  async finalizeRtmpStreamRecordingFromDisk({ sessionId, reason = 'stopped' } = {}) {
    const id = String(sessionId || '');
    const recording = this.streamRecordings.get(id);
    if (!recording) return null;
    if (recording.doneSettled) return recording.rtmpResult || null;
    const streamName = recording.rtmpStreamName || '';
    const rawFilePath = await waitForLatestStableRtmpRecordingFile(streamName);
    return this.finalizeRtmpStreamRecording({ sessionId: id, streamName, rawFilePath, reason });
  }

  async finalizeRtmpStreamRecording({ sessionId, streamName = '', rawFilePath = '', reason = 'recorded' } = {}) {
    const id = String(sessionId || '');
    const recording = this.streamRecordings.get(id);
    if (!recording) return null;
    if (recording.doneSettled) return recording.rtmpResult || null;
    if (recording.rtmpCompletion) return recording.rtmpCompletion;

    recording.rtmpCompletion = (async () => {
      recording.status = 'remuxing';
      recording.rawFilePath = rawFilePath || recording.rawFilePath || '';
      if (!recording.rawFilePath) throw new Error('rtmp_recording_raw_file_missing');
      const state = this.videoStreamSessions.get(id) || {};
      this.videoStreamSessions.set(id, {
        ...state,
        recording: publicStreamRecording(recording),
        updatedAt: new Date().toISOString()
      });
      const result = await this.streamRemuxer({
        inputPath: recording.rawFilePath,
        outputPath: recording.media.filePath
      });
      let audio = null;
      try {
        audio = await this.streamAudioExtractor({
          inputPath: recording.media.filePath,
          outputPath: recording.audioMedia.filePath
        });
      } catch (error) {
        recording.audioError = errorMessage(error);
        console.warn('Readwise stream audio extraction failed:', recording.audioError);
      }
      const doneResult = {
        ...result,
        reason,
        rawFilePath: recording.rawFilePath,
        outputPath: recording.media.filePath,
        audio
      };
      recording.doneSettled = true;
      recording.status = 'recorded';
      recording.rtmpResult = doneResult;
      recording.resolveDone?.(doneResult);
      this.rtmpRecordingsByStreamName.delete(streamName);
      return doneResult;
    })();

    try {
      return await recording.rtmpCompletion;
    } catch (error) {
      recording.doneSettled = true;
      recording.rejectDone?.(error);
      this.rtmpRecordingsByStreamName.delete(streamName);
      throw error;
    }
  }

  async stopStreamRecording({ sessionId, reason = 'manual' } = {}) {
    const id = String(sessionId || '');
    const recording = this.streamRecordings.get(id);
    if (!recording) return null;

    try {
      const result = await withTimeout(
        this.finalizeRtmpStreamRecordingFromDisk({ sessionId: id, reason }),
        getRtmpRecordingDoneTimeoutMs(),
        'rtmp_recording_done_timeout'
      );
      return await this.finishStreamRecording({ sessionId: id, result, reason });
    } catch (error) {
      return this.failStreamRecording({ sessionId: id, error });
    }
  }

  async finishStreamRecording({ sessionId, result = null, reason = 'recorded' } = {}) {
    const id = String(sessionId || '');
    const recording = this.streamRecordings.get(id);
    if (!recording) return null;
    if (recording.completion) return recording.completion;

    recording.completion = (async () => {
      const state = this.videoStreamSessions.get(id) || {};
      if (result?.rawFilePath && !recording.rawFilePath) recording.rawFilePath = result.rawFilePath;
      const media = await this.mediaStore.statMedia(recording.media);
      const audioMedia = await this.statOptionalAudioMedia(recording);
      const videoUrl = getPrivateMediaAppUrl(media.filename) || media.url || '';
      const audioUrl = getPrivateMediaAppUrl(audioMedia?.filename) || audioMedia?.url || '';
      const storedMedia = { ...media, url: videoUrl };
      const storedAudioMedia = audioMedia ? { ...audioMedia, url: audioUrl } : null;
      const draft = buildApprovalDraft({
        ocrText: buildStoredVideoReviewOcrText(''),
        videoUrl,
        audioUrl,
        sourceKind: 'book_video',
        requestId: recording.streamId || state.streamId || id,
        storage: storedMedia,
        audioStorage: storedAudioMedia,
        processing: {
          mode: 'queued',
          frameCount: 0,
          reason: 'stream_recorded_auto_queue'
        }
      });
      const entry = await this.notifyTelegramDraft(await this.highlightStore.create(draft), {
        reviewUrl: getPrivateReviewAppUrl('/review')
      });
      const publicRecording = {
        ...publicStreamRecording(recording),
        status: 'stored',
        stoppedAt: state.stoppedAt || new Date().toISOString(),
        size: media.size,
        url: videoUrl,
        audioFilename: storedAudioMedia?.filename,
        audioSize: storedAudioMedia?.size,
        audioUrl,
        highlightId: entry.id,
        reason
      };
      this.videoStreamSessions.set(id, {
        ...state,
        recording: publicRecording,
        updatedAt: new Date().toISOString()
      });
      this.streamRecordings.delete(id);
      this.noteSessionEvent(id, 'video_stream_recording_saved', {
        videoRecordingStatus: 'stored',
        videoUrl,
        audioUrl,
        videoDraftId: entry.id
      });
      return { entry, media: storedMedia, audioMedia: storedAudioMedia, result };
    })();

    return recording.completion;
  }

  async statOptionalAudioMedia(recording = {}) {
    const audioMedia = recording.audioMedia;
    if (!audioMedia?.filePath) return null;

    try {
      return await this.mediaStore.statMedia(audioMedia);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return null;
    }
  }

  async failStreamRecording({ sessionId, error } = {}) {
    const id = String(sessionId || '');
    const recording = this.streamRecordings.get(id);
    const state = this.videoStreamSessions.get(id) || {};
    const message = errorMessage(error);
    this.videoStreamSessions.set(id, {
      ...state,
      recording: recording ? { ...publicStreamRecording(recording), status: 'failed', error: message } : { status: 'failed', error: message },
      updatedAt: new Date().toISOString()
    });
    if (recording?.rtmpStreamName) this.rtmpRecordingsByStreamName.delete(recording.rtmpStreamName);
    this.streamRecordings.delete(id);
    this.noteSessionEvent(id, 'video_stream_recording_failed', {
      videoRecordingStatus: 'failed',
      error: message
    });
    console.error('Readwise video stream recording failed:', message);
    return null;
  }

  handleDirectRtmpStreamStatus({ sessionId, status } = {}) {
    const id = String(sessionId || '');
    const normalizedStatus = normalizeStreamStatus(status?.status || status?.state || '');
    const current = this.videoStreamSessions.get(id) || {};
    const diagnostics = buildStreamStatusDiagnostics(status);
    const next = {
      ...current,
      status: normalizedStatus || current.status || 'unknown',
      streamId: status?.streamId || status?.stream_id || current.streamId || '',
      updatedAt: new Date().toISOString(),
      ...diagnostics,
      ...(status?.errorDetails || status?.message ? { error: status.errorDetails || status.message } : {})
    };

    if (['initializing', 'preparing'].includes(normalizedStatus)) {
      next.active = false;
      next.needsStop = true;
      next.startedAt ||= new Date().toISOString();
    } else if (normalizedStatus === 'active') {
      next.active = true;
      next.needsStop = true;
      next.startedAt ||= new Date().toISOString();
    } else if (normalizedStatus === 'stopping') {
      next.active = false;
      next.needsStop = true;
    } else if (isTerminalStreamStatus(normalizedStatus)) {
      next.active = false;
      next.needsStop = false;
      next.stoppedAt ||= new Date().toISOString();
    } else if (normalizedStatus === 'error') {
      next.active = false;
      next.needsStop = true;
    }

    this.videoStreamSessions.set(id, next);
    this.noteSessionEvent(id, 'video_stream_status', {
      videoStreamStatus: next.status,
      videoStreamId: next.streamId,
      ...diagnostics,
      ...(next.error ? { error: next.error } : {})
    });
    if (isTerminalStreamStatus(normalizedStatus) && current.recording && current.recording.status !== 'stored') {
      this.stopStreamRecording({ sessionId: id, reason: `stream_status_${normalizedStatus}` }).catch((error) => {
        console.warn(`Readwise stream status save failed: ${errorMessage(error)}`);
      });
    }
    return next;
  }

  async toggleDirectRtmpVideoStream({ session, sessionId, reviewUrl = '', reason = 'manual', buttonEvent = null } = {}) {
    if (!isVideoStreamCaptureEnabled()) {
      this.noteSessionEvent(sessionId, 'video_stream_disabled');
      session?.layouts?.showTextWall?.('Readwise video stream is disabled.');
      return null;
    }

    const existing = this.videoStreamSessions.get(String(sessionId || ''));
    const sdkSaysActive = typeof session?.camera?.isCurrentlyStreaming === 'function' && Boolean(session.camera.isCurrentlyStreaming());
    const shouldStop = shouldStopVideoStream(existing) || sdkSaysActive;
    if (shouldStop && shouldIgnoreEarlyStreamStop(existing, { buttonEvent })) {
      this.noteSessionEvent(sessionId, 'video_stream_stop_ignored_warmup', {
        videoStreamStatus: existing?.status || 'starting',
        buttonEvent: normalizeButtonEventType(buttonEvent) || 'unknown'
      });
      session?.layouts?.showTextWall?.('Readwise recording is starting. Press again in a few seconds to stop.');
      return existing || null;
    }
    if (shouldStop) {
      return this.stopDirectRtmpVideoStream({ session, sessionId, reviewUrl, reason });
    }
    return this.startDirectRtmpVideoStream({ session, sessionId, reviewUrl, reason });
  }

  async startDirectRtmpVideoStream({ session, sessionId, reviewUrl = '', reason = 'manual' } = {}) {
    if (typeof session?.camera?.startStream !== 'function') {
      const message = 'Direct RTMP stream is not available in this Mentra cloud session.';
      this.noteSessionEvent(sessionId, 'video_stream_failed', { error: message, videoStreamStatus: 'failed' });
      session?.layouts?.showTextWall?.(message);
      return null;
    }

    const id = String(sessionId || '');
    try {
      this.noteSessionEvent(id, 'video_stream_start_requested', {
        videoStreamStatus: 'starting',
        videoRecordingMode: 'direct_rtmp'
      });
      session?.layouts?.showTextWall?.('Starting Readwise video stream...');
      const streamId = `readwise_${Date.now()}_${randomUUID().slice(0, 8)}`;
      const rtmpRecording = await this.prepareRtmpStreamRecording({
        sessionId: id,
        state: { streamId }
      });
      if (!rtmpRecording?.destination?.url) throw new Error('rtmp_ingest_not_ready');

      const options = buildDirectRtmpStreamOptions(rtmpRecording.destination.url);
      this.videoStreamSessions.set(id, {
        active: false,
        needsStop: true,
        status: 'starting',
        streamId,
        reason,
        options: redactRtmpStreamOptions(options),
        startedAt: new Date().toISOString(),
        recording: publicStreamRecording(rtmpRecording.recording)
      });
      await session.camera.startStream(options);
      const state = {
        ...(this.videoStreamSessions.get(id) || {}),
        active: true,
        needsStop: true,
        status: 'active',
        streamId,
        startedAt: new Date().toISOString()
      };
      this.videoStreamSessions.set(id, state);
      this.noteSessionEvent(id, 'video_stream_started', {
        videoStreamStatus: 'active',
        videoStreamId: streamId,
        videoRecordingStatus: state.recording?.status,
        videoRecordingMode: 'direct_rtmp'
      });
      session?.layouts?.showTextWall?.('Readwise recording started.');
      return state;
    } catch (error) {
      const message = errorMessage(error);
      const current = this.videoStreamSessions.get(id) || {};
      const recording = this.streamRecordings.get(id);
      if (recording?.rtmpStreamName) this.rtmpRecordingsByStreamName.delete(recording.rtmpStreamName);
      this.streamRecordings.delete(id);
      this.videoStreamSessions.set(id, {
        ...current,
        active: false,
        needsStop: true,
        status: 'failed',
        error: message,
        updatedAt: new Date().toISOString()
      });
      this.noteSessionEvent(id, 'video_stream_failed', {
        error: message,
        videoStreamStatus: 'failed',
        videoRecordingMode: 'direct_rtmp'
      });
      console.error('Readwise direct RTMP video stream failed:', message);
      session?.layouts?.showTextWall?.(`Video stream failed: ${message}. Double/long press again to clear it.`);
      return null;
    }
  }

  async stopDirectRtmpVideoStream({ session, sessionId, reviewUrl = '', reason = 'manual' } = {}) {
    const id = String(sessionId || '');
    const existing = this.videoStreamSessions.get(id);
    const sdkSaysActive = typeof session?.camera?.isCurrentlyStreaming === 'function' && Boolean(session.camera.isCurrentlyStreaming());
    if (!shouldStopVideoStream(existing) && !sdkSaysActive) {
      this.noteSessionEvent(id, 'video_stream_stop_ignored', {
        videoStreamStatus: 'inactive'
      });
      session?.layouts?.showTextWall?.('No Readwise video stream is active.');
      return null;
    }

    if (typeof session?.camera?.stopStream !== 'function') {
      const message = 'Direct RTMP stream stop is not available in this Mentra cloud session.';
      this.noteSessionEvent(id, 'video_stream_stop_failed', {
        error: message,
        videoStreamStatus: 'failed',
        videoStreamId: existing?.streamId || ''
      });
      session?.layouts?.showTextWall?.(message);
      return null;
    }

    try {
      this.noteSessionEvent(id, 'video_stream_stop_requested', {
        videoStreamStatus: 'stopping',
        videoStreamId: existing?.streamId || ''
      });
      session?.layouts?.showTextWall?.('Stopping Readwise video stream...');
      await session.camera.stopStream();
      const state = {
        ...(this.videoStreamSessions.get(id) || existing || {}),
        active: false,
        needsStop: false,
        status: 'stopped',
        stopReason: reason,
        stoppedAt: new Date().toISOString()
      };
      this.videoStreamSessions.set(id, state);
      await this.stopStreamRecording({ sessionId: id, reason });
      const stoppedState = this.videoStreamSessions.get(id) || state;
      this.noteSessionEvent(id, 'video_stream_stopped', {
        videoStreamStatus: 'stopped',
        videoStreamId: stoppedState.streamId,
        videoRecordingStatus: stoppedState.recording?.status,
        videoUrl: stoppedState.recording?.url
      });
      session?.layouts?.showTextWall?.('Readwise recording stopped.');
      return stoppedState;
    } catch (error) {
      const message = errorMessage(error);
      this.noteSessionEvent(id, 'video_stream_stop_failed', {
        error: message,
        videoStreamStatus: 'failed',
        videoStreamId: existing?.streamId || ''
      });
      console.error('Readwise direct RTMP video stream stop failed:', message);
      session?.layouts?.showTextWall?.(`Video stream stop failed: ${message}`);
      return null;
    }
  }

  async extractPageText({ filePath, transcript }) {
    try {
      const result = await this.ocrExtractor({ filePath });
      const text = normalizeExtractedText(result?.text);
      return text || buildReviewOcrText(transcript);
    } catch (_error) {
      return buildReviewOcrText(transcript);
    }
  }

  async extractVideoText({ frames = [], transcript }) {
    const texts = [];
    for (const frame of frames.slice(0, getVideoOcrFrameLimit())) {
      try {
        const result = await this.ocrExtractor({ filePath: frame.filePath });
        const text = normalizeExtractedText(result?.text);
        if (text) texts.push(text);
      } catch (_error) {
        // A single unreadable frame should not discard the whole recording.
      }
    }

    const combined = texts.join('\n\n').trim();
    return appendTranscriptNote(combined || buildVideoReviewOcrText(transcript), transcript);
  }

  async resolveUploadedImage(request, { label = 'book_page' } = {}) {
    const uploaded = getUploadedFile(request, ['photo', 'file', 'image']);
    if (uploaded) {
      if (!String(uploaded.mimetype).startsWith('image/')) {
        throw new Error('Uploaded media must be an image.');
      }

      return this.mediaStore.saveBuffer(uploaded.buffer, {
        originalName: uploaded.originalname,
        mimeType: uploaded.mimetype,
        publicBaseUrl: process.env.PUBLIC_URL,
        label
      });
    }

    const encoded = request.body?.imageBase64 || request.body?.photoBase64 || request.body?.mediaBase64;
    if (!encoded) return null;

    const mimeType = request.body?.imageMimeType || request.body?.mediaMimeType || mimeTypeFromDataUri(encoded) || 'image/jpeg';
    if (!String(mimeType).startsWith('image/')) {
      throw new Error('Uploaded media must be an image.');
    }

    return this.mediaStore.saveBuffer(Buffer.from(stripDataUri(encoded), 'base64'), {
      originalName: request.body?.imageFileName || request.body?.mediaFileName || request.body?.filename || 'page.jpg',
      mimeType,
      publicBaseUrl: process.env.PUBLIC_URL,
      label
    });
  }

  async resolveUploadedVideo(request, { label = 'book_video' } = {}) {
    const uploaded = getUploadedFile(request, ['video', 'file']);
    if (uploaded) {
      if (!isVideoMimeType(uploaded.mimetype, uploaded.originalname)) {
        throw new Error('Uploaded media must be a video.');
      }

      return this.mediaStore.saveBuffer(uploaded.buffer, {
        originalName: uploaded.originalname,
        mimeType: uploaded.mimetype || mimeTypeForFilename(uploaded.originalname) || 'video/mp4',
        publicBaseUrl: process.env.PUBLIC_URL,
        label
      });
    }

    const encoded = request.body?.videoBase64 || request.body?.mediaBase64;
    if (!encoded) return null;

    const mimeType = request.body?.videoMimeType || request.body?.mediaMimeType || mimeTypeFromDataUri(encoded) || 'video/mp4';
    if (!isVideoMimeType(mimeType, request.body?.videoFileName || request.body?.mediaFileName || request.body?.filename)) {
      throw new Error('Uploaded media must be a video.');
    }

    return this.mediaStore.saveBuffer(Buffer.from(stripDataUri(encoded), 'base64'), {
      originalName: request.body?.videoFileName || request.body?.mediaFileName || request.body?.filename || 'book-video.mp4',
      mimeType,
      publicBaseUrl: process.env.PUBLIC_URL,
      label
    });
  }

  async notifyTelegramDraft(entry, { reviewUrl = '' } = {}) {
    const telegram = getReadwiseTelegramConfig();
    if (!telegram.enabled) return entry;

    try {
      const result = await sendTelegramReadwiseDraft({
        entry,
        reviewUrl,
        telegram,
        fetchImpl: this.telegramFetch
      });
      if (!result.message?.message_id) return entry;

      return this.highlightStore.set(
        entry.id,
        withTelegramDraftMessageMetadata(entry.draft, {
          chatId: result.message.chat?.id || telegram.chatId,
          messageId: result.message.message_id,
          mode: result.mode
        })
      );
    } catch (error) {
      console.warn(`Readwise Telegram draft notification failed: ${error.message || error}`);
      return entry;
    }
  }

  async handleReadwiseTelegramUpdate(update = {}) {
    const callback = update?.callback_query;
    if (!callback) return { status: 'ignored' };

    const parsed = parseReadwiseTelegramCallback(callback.data);
    if (!parsed) return { status: 'ignored' };

    const resolved = await resolveReadwiseCandidateFromToken(parsed.token, { highlightStore: this.highlightStore });
    if (!resolved) {
      await answerTelegramReadwiseCallback({
        callback,
        text: 'Candidate not found.',
        fetchImpl: this.telegramFetch
      });
      await editTelegramReadwiseCallbackMessage({
        callback,
        text: 'This generated Readwise candidate is no longer pending.',
        fetchImpl: this.telegramFetch
      });
      return { status: 'not_found' };
    }

    if (resolved.review?.status) {
      await answerTelegramReadwiseCallback({
        callback,
        text: `Already ${resolved.review.status}.`,
        fetchImpl: this.telegramFetch
      });
      await editTelegramReadwiseCallbackMessage({
        callback,
        text: formatTelegramReadwiseCandidateFinalText(resolved.candidate, { status: resolved.review.status }),
        fetchImpl: this.telegramFetch
      });
      return { status: 'already_reviewed', id: resolved.entry.id, reviewStatus: resolved.review.status };
    }

    if (parsed.action === 'approve') {
      return approveReadwiseTelegramCandidate({
        ...resolved,
        callback,
        highlightStore: this.highlightStore,
        fetchImpl: this.telegramFetch
      });
    }

    return rejectReadwiseTelegramCandidate({
      ...resolved,
      callback,
      highlightStore: this.highlightStore,
      fetchImpl: this.telegramFetch
    });
  }
}

function normalizeButtonEventType(event = {}) {
  return String(event.pressType || event.type || event.eventType || event.action || event.buttonEvent || '').toLowerCase();
}

function getVideoStreamRuntimeMode() {
  if (!isVideoStreamCaptureEnabled()) return 'disabled';
  return isRtmpIngestEnabled() ? 'direct_rtmp_mp4' : 'direct_rtmp_ingest_disabled';
}

function isVideoStreamCaptureEnabled() {
  return process.env.READWISE_VIDEO_STREAM_CAPTURE !== '0';
}

function isRtmpIngestEnabled() {
  return isVideoStreamCaptureEnabled() && process.env.READWISE_RTMP_INGEST_ENABLED === '1';
}

function getPrivateStreamMediaPublicBaseUrl() {
  return process.env.MEDIA_PUBLIC_VIDEO_ACCESS === '1' ? process.env.PUBLIC_URL : '';
}

function buildDirectRtmpStreamOptions(rtmpUrl) {
  const maxSeconds = getReadwiseStreamMaxSeconds();
  const video = compactObject({
    width: getOptionalPositiveInt(process.env.READWISE_STREAM_WIDTH) || 1280,
    height: getOptionalPositiveInt(process.env.READWISE_STREAM_HEIGHT) || 720,
    frameRate: getOptionalPositiveInt(process.env.READWISE_STREAM_FRAME_RATE) || 30,
    bitrate: getOptionalPositiveInt(process.env.READWISE_STREAM_VIDEO_BITRATE) || 2500000
  });
  const audio = compactObject({
    bitrate: getOptionalPositiveInt(process.env.READWISE_STREAM_AUDIO_BITRATE) || 128000,
    sampleRate: getOptionalPositiveInt(process.env.READWISE_STREAM_AUDIO_SAMPLE_RATE) || 44100,
    echoCancellation: process.env.READWISE_STREAM_AUDIO_ECHO_CANCELLATION === '1',
    noiseSuppression: process.env.READWISE_STREAM_AUDIO_NOISE_SUPPRESSION === '1'
  });
  return compactObject({
    rtmpUrl,
    ...(Object.keys(video).length ? { video } : {}),
    ...(process.env.READWISE_STREAM_AUDIO_CAPTURE === '0' ? {} : { audio }),
    stream: maxSeconds ? { durationLimit: maxSeconds } : undefined
  });
}

function redactRtmpStreamOptions(options = {}) {
  return {
    ...options,
    rtmpUrl: options.rtmpUrl ? redactRtmpUrl(options.rtmpUrl) : ''
  };
}

function redactRtmpUrl(value = '') {
  try {
    const url = new URL(value);
    if (url.search) url.search = '?sign=redacted';
    return url.toString();
  } catch (_error) {
    return String(value || '').replace(/sign=[^&\s]+/g, 'sign=redacted');
  }
}

function compactObject(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function getOptionalPositiveInt(value) {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function getReadwiseStreamMaxSeconds() {
  const raw = process.env.READWISE_STREAM_MAX_SECONDS;
  if (raw === undefined || raw === '') return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function getStreamRecordingLabel() {
  return sanitizeFilenameSegment(process.env.READWISE_STREAM_RECORDING_LABEL || 'book_video');
}

function getRtmpIngestPort() {
  const parsed = Number(process.env.READWISE_RTMP_INGEST_PORT || 1935);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1935;
}

function getRtmpIngestAppName() {
  return sanitizeFilenameSegment(process.env.READWISE_RTMP_INGEST_APP || 'readwise');
}

function getRtmpPublicHost() {
  const explicit = String(process.env.READWISE_RTMP_PUBLIC_HOST || '').trim();
  if (explicit) return explicit;
  try {
    return new URL(process.env.PUBLIC_URL || '').hostname || 'example.com';
  } catch (_error) {
    return 'example.com';
  }
}

function getRtmpRecordDir() {
  return process.env.READWISE_RTMP_RECORD_DIR || path.join(process.cwd(), 'data', 'rtmp-recordings');
}

function getRtmpRecordStreamDir(streamName = '') {
  const safeStreamName = sanitizeFilenameSegment(streamName);
  if (!safeStreamName) return '';
  return path.join(getRtmpRecordDir(), getRtmpIngestAppName(), safeStreamName);
}

function getRtmpIngestSignTtlSeconds() {
  const parsed = Number(process.env.READWISE_RTMP_INGEST_SIGN_TTL_SECONDS || 2 * 60 * 60);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(4 * 60 * 60, Math.floor(parsed)) : 2 * 60 * 60;
}

function getRtmpRecordingDoneTimeoutMs() {
  const parsed = Number(process.env.READWISE_RTMP_RECORDING_DONE_TIMEOUT_MS || 60000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 60000;
}

function getRtmpFallbackRecordingReadyTimeoutMs() {
  const parsed = Number(process.env.READWISE_RTMP_FALLBACK_RECORDING_READY_TIMEOUT_MS || 180000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 180000;
}

function getRtmpFallbackRecordingReadyIntervalMs() {
  const parsed = Number(process.env.READWISE_RTMP_FALLBACK_RECORDING_READY_INTERVAL_MS || 500);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 500;
}

function getRtmpFallbackRecordingStableMs() {
  const parsed = Number(process.env.READWISE_RTMP_FALLBACK_RECORDING_STABLE_MS || 1000);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1000;
}

async function waitForLatestStableRtmpRecordingFile(streamName = '') {
  const dir = getRtmpRecordStreamDir(streamName);
  if (!dir) throw new Error('rtmp_recording_stream_name_missing');

  const timeoutMs = getRtmpFallbackRecordingReadyTimeoutMs();
  const intervalMs = getRtmpFallbackRecordingReadyIntervalMs();
  const stableMs = getRtmpFallbackRecordingStableMs();
  const deadline = Date.now() + timeoutMs;
  let lastPath = '';
  let lastSize = -1;
  let stableSince = 0;
  let lastSeen = null;

  while (true) {
    const latest = await findLatestRtmpRecordingFile(dir);
    if (latest?.filePath && latest.size > 0) {
      lastSeen = latest;
      const unchanged = latest.filePath === lastPath && latest.size === lastSize;
      if (!unchanged) {
        lastPath = latest.filePath;
        lastSize = latest.size;
        stableSince = Date.now();
      } else if (stableMs === 0 || Date.now() - stableSince >= stableMs) {
        return latest.filePath;
      }
    }

    if (Date.now() >= deadline) {
      if (lastSeen?.filePath && Date.now() - lastSeen.mtimeMs >= stableMs) return lastSeen.filePath;
      throw new Error(`rtmp_recording_file_not_ready timeout=${timeoutMs}ms dir=${dir}`);
    }
    await sleep(intervalMs);
  }
}

async function findLatestRtmpRecordingFile(dir) {
  let filenames;
  try {
    filenames = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const candidates = [];
  for (const filename of filenames) {
    if (!filename.endsWith('.flv')) continue;
    const filePath = path.join(dir, filename);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    candidates.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
}

function publicStreamRecording(recording = {}) {
  return compactObject({
    id: recording.id,
    status: recording.status,
    reason: recording.reason,
    mode: recording.mode,
    streamId: recording.streamId,
    startedAt: recording.startedAt,
    rawStored: Boolean(recording.rawFilePath),
    url: recording.media?.url,
    filename: recording.media?.filename,
    size: recording.media?.size,
    audioUrl: recording.audioMedia?.url,
    audioFilename: recording.audioMedia?.filename,
    audioSize: recording.audioMedia?.size
  });
}

function normalizeStreamStatus(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 40) || 'unknown';
}

function buildStreamStatusDiagnostics(status = {}) {
  const stats = compactPlainObject(status?.stats);
  const resolvedConfig = compactPlainObject(status?.resolvedConfig || status?.resolved_config || stats.resolvedConfig || stats.resolved_config);
  return compactObject({
    streamStats: Object.keys(stats).length ? stats : undefined,
    resolvedConfig: Object.keys(resolvedConfig).length ? resolvedConfig : undefined
  });
}

function compactPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function isTerminalStreamStatus(status = '') {
  return ['stopped', 'timeout', 'ended', 'finished', 'disconnected', 'closed'].includes(normalizeStreamStatus(status));
}

function shouldStopVideoStream(state = {}) {
  if (!state) return false;
  if (state.needsStop) return true;
  return ['starting', 'initializing', 'preparing', 'active', 'stopping', 'error', 'failed'].includes(state.status);
}

function shouldIgnoreEarlyStreamStop(state = {}, { buttonEvent = null, now = Date.now() } = {}) {
  if (!state || !isStreamWarmupStatus(state.status)) return false;
  if (isExplicitStreamStopButtonEvent(buttonEvent)) return false;
  const guardMs = getStreamStartStopGuardMs();
  if (!guardMs) return false;
  const startedAt = Date.parse(state.startedAt || state.updatedAt || '');
  if (!Number.isFinite(startedAt)) return false;
  return Number(now) - startedAt < guardMs;
}

function isStreamWarmupStatus(status = '') {
  return ['starting', 'initializing', 'preparing'].includes(normalizeStreamStatus(status));
}

function isExplicitStreamStopButtonEvent(event = {}) {
  const buttonEvent = normalizeButtonEventType(event);
  return buttonEvent.includes('double') || buttonEvent.includes('long') || buttonEvent.includes('hold') || buttonEvent.includes('stop');
}

function getStreamStartStopGuardMs() {
  const raw = process.env.READWISE_STREAM_START_STOP_GUARD_MS;
  if (raw === undefined || raw === '') return 8000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

async function withTimeout(promise, timeoutMs, label = 'timeout') {
  const timeout = Number(timeoutMs || 0);
  if (!Number.isFinite(timeout) || timeout <= 0) return promise;

  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeout);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getUploadedFile(request, fieldNames = []) {
  if (request.file) return request.file;
  for (const fieldName of fieldNames) {
    const candidate = request.files?.[fieldName]?.[0];
    if (candidate) return candidate;
  }
  return null;
}

function buildReviewOcrText(transcript = '') {
  const text = String(transcript || '')
    .replace(/\b(capture|take|snap|scan|photo|picture|page|book)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length >= 12) {
    return `[HIGHLIGHT] ${text}`;
  }
  return '[HIGHLIGHT] OCR pending. Review the captured page image and replace this text before approving.';
}

function buildVideoReviewOcrText(transcript = '') {
  const note = normalizeNoteText(transcript);
  return [
    '[HIGHLIGHT] OCR pending. Review the sampled book video frames and replace this text before approving.',
    note ? `[NOTE] ${note}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function buildStoredVideoReviewOcrText(transcript = '') {
  const note = normalizeNoteText(transcript);
  return [
    '[HIGHLIGHT] Stored reading video pending review. Open the source video and add the final highlight text before sending to Readwise.',
    note ? `[NOTE] ${note}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function appendTranscriptNote(ocrText = '', transcript = '') {
  const normalized = normalizeExtractedText(ocrText);
  const note = normalizeNoteText(transcript);
  if (!note || /\[NOTE\]/i.test(normalized)) return normalized;
  return `${normalized}\n[NOTE] ${note}`;
}

function normalizeNoteText(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

function extensionForMime(mimeType = '') {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'video/mp4') return '.mp4';
  if (mimeType === 'video/quicktime') return '.mov';
  if (mimeType === 'video/webm') return '.webm';
  if (mimeType === 'audio/mp4') return '.m4a';
  if (mimeType === 'audio/mpeg') return '.mp3';
  if (mimeType === 'audio/wav') return '.wav';
  return '';
}

function extensionForFilename(filename = '') {
  const extension = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '';
}

function mimeTypeForFilename(filename = '') {
  const extension = extensionForFilename(filename);
  if (extension === '.mp4') return 'video/mp4';
  if (extension === '.mov') return 'video/quicktime';
  if (extension === '.webm') return 'video/webm';
  if (extension === '.m4a') return 'audio/mp4';
  if (extension === '.mp3') return 'audio/mpeg';
  if (extension === '.wav') return 'audio/wav';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  return '';
}

function isVideoMimeType(mimeType = '', filename = '') {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.startsWith('video/')) return true;
  if (normalized === 'application/octet-stream') {
    return ['.mp4', '.mov', '.webm'].includes(extensionForFilename(filename));
  }
  return ['.mp4', '.mov', '.webm'].includes(extensionForFilename(filename));
}

function mediaKindForFilename(filename = '') {
  const mimeType = mimeTypeForFilename(filename);
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('image/')) return 'image';
  return 'file';
}

function sanitizeMediaFilename(filename = '') {
  const clean = String(filename || '').trim();
  if (!clean || clean !== path.basename(clean) || clean.includes('/') || clean.includes('\\')) return '';
  return clean;
}

function sanitizeFilenameSegment(value = '') {
  const cleaned = String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 80) || 'capture';
}

function mediaCreatedAtMs(filename = '', stat = {}) {
  const timestamp = timestampFromMediaFilename(filename);
  if (timestamp) return timestamp;

  for (const value of [stat.birthtimeMs, stat.mtimeMs, stat.ctimeMs]) {
    if (Number.isFinite(value) && value > 0) return value;
  }
  return Date.now();
}

function timestampFromMediaFilename(filename = '') {
  const match = String(filename || '').match(/_(\d{10,})_/);
  if (!match) return 0;
  const timestamp = Number(match[1]);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function mimeTypeFromDataUri(value = '') {
  return String(value).match(/^data:([^;,]+)[;,]/)?.[1] || '';
}

function stripDataUri(value = '') {
  return String(value).replace(/^data:[^,]+,/, '');
}

function isHttpUrl(url = '') {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

function normalizeExtractedText(text = '') {
  return String(text || '').replace(/\r\n/g, '\n').trim().slice(0, 8000);
}

function errorMessage(error) {
  return error?.message || String(error || '');
}

function getUploadLimitBytes() {
  const parsed = Number(process.env.MEDIA_UPLOAD_LIMIT_BYTES || 120 * 1024 * 1024);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 120 * 1024 * 1024;
}

function getExpressBodyLimit() {
  return `${getUploadLimitBytes()}b`;
}

function getVideoOcrFrameLimit() {
  const parsed = Number(process.env.READWISE_VIDEO_OCR_FRAME_LIMIT || 4);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(20, Math.floor(parsed)) : 4;
}

function isHtmlRequest(request) {
  const accept = request.get('accept') || '';
  return request.is('application/x-www-form-urlencoded') || (accept.includes('text/html') && !accept.includes('application/json'));
}

function getBasePath(request) {
  return normalizeBasePath(request.get('x-forwarded-prefix') || process.env.PUBLIC_PATH || '');
}

function buildPublishManifest(
  request,
  { name, packageName, description, reviewPath, queuePath, writeMode, writeModeDescription, captureEndpoints, approvalGate, streamMode }
) {
  const iconUrl = getPublicUrl(request, '/assets/app-icon.png');
  const appUrl = getPublicUrl(request);

  return {
    schemaVersion: 1,
    name,
    packageName,
    description,
    appUrl,
    healthUrl: getPublicUrl(request, '/health'),
    reviewUrl: getPublicUrl(request, reviewPath),
    iconUrl,
    iconSvgUrl: getPublicUrl(request, '/assets/app-icon.svg'),
    bridgeAuthRequired: Boolean(process.env.MENTRA_BRIDGE_TOKEN),
    writeMode,
    writeModeDescription,
    approvalGate,
    streamMode,
    mentraDeveloperConsole: {
      name,
      packageName,
      webhookUrl: appUrl,
      iconUrl,
      healthUrl: getPublicUrl(request, '/health')
    },
    endpoints: {
      authCheck: getPublicUrl(request, '/api/bridge-auth-check'),
      queue: getPublicUrl(request, queuePath),
      review: getPublicUrl(request, reviewPath),
      capture: captureEndpoints.map((endpoint) => getPublicUrl(request, endpoint))
    },
    testing: {
      publicSmokeCommand: 'npm run smoke:public',
      noWriteDefault: writeMode === 'dry_run'
    }
  };
}

function getPublicUrl(request, pathName = '') {
  const explicitBase = process.env.PUBLIC_URL;
  const base = explicitBase ? explicitBase.replace(/\/+$/, '') : `${requestProtocol(request)}://${requestHost(request)}${getBasePath(request)}`;
  const suffix = String(pathName || '').trim();
  if (!suffix) return base;
  return `${base}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

function getPublicAppUrl(pathName = '') {
  const base = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');
  if (!base) return '';
  if (!pathName) return base;
  return `${base}${String(pathName).startsWith('/') ? '' : '/'}${pathName}`;
}

function getPrivateMediaAppUrl(filename = '') {
  const safeFilename = sanitizeMediaFilename(filename);
  if (!safeFilename) return '';
  const base = getPublicAppUrl(`/media/private/${encodeURIComponent(safeFilename)}`);
  if (!base) return '';
  const token = buildMediaAccessToken(safeFilename);
  if (!token) return base;
  const url = new URL(base);
  url.searchParams.set('mediaToken', token);
  return url.toString();
}

function getPrivateReviewAppUrl(pathName = '/review') {
  const base = getPublicAppUrl(pathName);
  if (!base) return '';
  const token = buildReviewAccessToken(pathName);
  if (!token) return base;
  const url = new URL(base);
  url.searchParams.set('reviewAccessToken', token);
  return url.toString();
}

function requestProtocol(request) {
  return request.get('x-forwarded-proto') || request.protocol || 'http';
}

function requestHost(request) {
  return request.get('x-forwarded-host') || request.get('host') || 'localhost';
}

function requireBridgeToken(request, response, next) {
  const expected = process.env.MENTRA_BRIDGE_TOKEN;
  if (!expected) {
    next();
    return;
  }

  const provided = request.get('x-mentra-bridge-token') || bearerToken(request.get('authorization')) || bodyBridgeToken(request.body);
  if (provided === expected) {
    next();
    return;
  }

  response.status(401).json({ error: 'unauthorized' });
}

function requireReadwiseTelegramForwardAccess(request, response, next) {
  const expected = process.env.READWISE_TELEGRAM_FORWARD_TOKEN;
  if (!expected) {
    response.status(503).json({ error: 'readwise_telegram_forward_token_not_configured' });
    return;
  }

  const provided =
    request.get('x-readwise-telegram-forward-token') ||
    bearerToken(request.get('authorization')) ||
    bodyBridgeToken(request.body);
  if (isTokenEqual(provided, expected)) {
    next();
    return;
  }

  response.status(401).json({ error: 'unauthorized' });
}

function requireReviewAccess(request, response, next) {
  const expected = getReviewToken();
  if (!expected) {
    response.set('Cache-Control', 'no-store');
    if (isProductionRuntime()) {
      response.status(503).type('text/plain').send('Review token is not configured.');
      return;
    }
    next();
    return;
  }

  if (isValidReviewAccessToken(request)) {
    response.set('Cache-Control', 'no-store');
    if (request.method === 'GET') {
      setReviewCookie({ request, response, token: expected });
      response.redirect(303, cleanReviewTokenRedirectPath(request));
      return;
    }
    next();
    return;
  }

  const provided = reviewTokenFromRequest(request);
  if (isTokenEqual(provided, expected)) {
    response.set('Cache-Control', 'no-store');
    if (request.method === 'GET' && hasReviewTokenQuery(request)) {
      setReviewCookie({ request, response, token: expected });
      response.redirect(303, cleanReviewTokenRedirectPath(request));
      return;
    }
    next();
    return;
  }

  response.set('Cache-Control', 'no-store');
  response.status(404).type('text/plain').send('Not found');
}

function requirePrivateMediaAccess(request, response, next) {
  if (isValidMediaAccessToken(request.params.filename, request.query?.mediaToken)) {
    response.set('Cache-Control', 'private, no-store');
    next();
    return;
  }
  return requireReviewAccess(request, response, next);
}

function getReviewToken() {
  return process.env.READWISE_REVIEW_TOKEN || process.env.ALERIO_REVIEW_TOKEN || process.env.REVIEW_TOKEN || '';
}

function reviewTokenFromRequest(request) {
  return (
    request.get('x-alerio-review-token') ||
    request.get('x-readwise-review-token') ||
    bearerToken(request.get('authorization')) ||
    request.query?.reviewToken ||
    request.query?.token ||
    request.body?.reviewToken ||
    request.body?.token ||
    cookieValue(request.get('cookie'), REVIEW_COOKIE_NAME) ||
    ''
  );
}

function hasReviewTokenQuery(request) {
  return Boolean(request.query?.reviewToken || request.query?.token);
}

function cleanReviewTokenRedirectPath(request) {
  const parsed = new URL(request.originalUrl || request.url || '/', 'http://local');
  parsed.searchParams.delete('reviewToken');
  parsed.searchParams.delete('token');
  parsed.searchParams.delete('reviewAccessToken');
  const pathName = `${getBasePath(request)}${parsed.pathname}`;
  return `${pathName}${parsed.search || ''}`;
}

function setReviewCookie({ request, response, token }) {
  const cookie = [
    `${REVIEW_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=' + (getBasePath(request) || '/'),
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=2592000'
  ];
  if (requestProtocol(request) === 'https') cookie.push('Secure');
  response.set('Set-Cookie', cookie.join('; '));
}

function buildMediaAccessToken(filename = '', nowSeconds = Math.floor(Date.now() / 1000)) {
  const secret = getMediaTokenSecret();
  const safeFilename = sanitizeMediaFilename(filename);
  if (!secret || !safeFilename) return '';
  const expiresAt = nowSeconds + getMediaTokenTtlSeconds();
  const signature = createHmac('sha256', secret).update(`${safeFilename}.${expiresAt}`).digest('base64url').slice(0, 43);
  return `${expiresAt}.${signature}`;
}

function buildReviewAccessToken(pathName = '/review', nowSeconds = Math.floor(Date.now() / 1000)) {
  const secret = getReviewLinkSecret();
  const normalizedPath = normalizeReviewAccessPath(pathName);
  if (!secret || !normalizedPath) return '';
  const expiresAt = nowSeconds + getReviewLinkTtlSeconds();
  const signature = createHmac('sha256', secret).update(`${normalizedPath}.${expiresAt}`).digest('base64url').slice(0, 43);
  return `${expiresAt}.${signature}`;
}

function isValidMediaAccessToken(filename = '', token = '') {
  const secret = getMediaTokenSecret();
  const safeFilename = sanitizeMediaFilename(filename);
  const match = String(token || '').match(/^(\d{10,})\.([a-zA-Z0-9_-]{32,80})$/);
  if (!secret || !safeFilename || !match) return false;
  const expiresAt = Number(match[1]);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac('sha256', secret).update(`${safeFilename}.${expiresAt}`).digest('base64url').slice(0, 43);
  return isTokenEqual(match[2], expected);
}

function isValidReviewAccessToken(request) {
  const secret = getReviewLinkSecret();
  const token = String(request.query?.reviewAccessToken || '');
  const match = token.match(/^(\d{10,})\.([a-zA-Z0-9_-]{32,80})$/);
  if (!secret || !match) return false;
  const expiresAt = Number(match[1]);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;
  const pathName = normalizeReviewAccessPath(request.path || request.originalUrl || '/review');
  const expected = createHmac('sha256', secret).update(`${pathName}.${expiresAt}`).digest('base64url').slice(0, 43);
  return isTokenEqual(match[2], expected);
}

function getMediaTokenSecret() {
  return process.env.READWISE_MEDIA_TOKEN_SECRET || getReviewToken();
}

function getReviewLinkSecret() {
  return process.env.READWISE_REVIEW_LINK_SECRET || process.env.READWISE_MEDIA_TOKEN_SECRET || getReviewToken();
}

function getMediaTokenTtlSeconds() {
  const parsed = Number(process.env.READWISE_MEDIA_TOKEN_TTL_SECONDS || 7 * 24 * 60 * 60);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(30 * 24 * 60 * 60, Math.floor(parsed)) : 7 * 24 * 60 * 60;
}

function getReviewLinkTtlSeconds() {
  const parsed = Number(process.env.READWISE_REVIEW_LINK_TTL_SECONDS || 7 * 24 * 60 * 60);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(30 * 24 * 60 * 60, Math.floor(parsed)) : 7 * 24 * 60 * 60;
}

function normalizeReviewAccessPath(pathName = '/review') {
  const parsed = new URL(String(pathName || '/review'), 'http://local');
  const pathOnly = parsed.pathname || '/review';
  return pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`;
}

function isProductionRuntime() {
  return process.env.NODE_ENV === 'production' && process.env.ALLOW_UNAUTHENTICATED_LOCAL_DEV !== '1';
}

function cookieValue(cookieHeader = '', name = '') {
  const prefix = `${name}=`;
  for (const part of String(cookieHeader || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(trimmed.slice(prefix.length));
    } catch (_error) {
      return '';
    }
  }
  return '';
}

function isTokenEqual(value = '', expected = '') {
  const left = Buffer.from(String(value || ''));
  const right = Buffer.from(String(expected || ''));
  if (!left.length || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function sendTelegramReadwiseDraft({ entry, reviewUrl = '', telegram, fetchImpl = fetch }) {
  const response = await fetchImpl(telegramApiUrl(telegram.token, 'sendMessage'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegram.chatId,
      text: truncateTelegramText(formatTelegramReadwiseDraftText(entry, reviewUrl), 3900),
      reply_markup: buildTelegramReadwiseReplyMarkup(entry, reviewUrl),
      disable_web_page_preview: false
    })
  });

  if (!response.ok) throw new Error(`Telegram send failed: ${response.status} ${await safeResponseText(response)}`);
  const payload = await safeResponseJson(response);
  return { ok: true, mode: 'message', status: response.status, message: payload?.result || null };
}

async function notifyTelegramReadwiseProcessedDraft(entry, { telegramFetch = fetch, highlightStore } = {}) {
  const telegram = getReadwiseTelegramConfig();
  if (!telegram.enabled) return entry;

  try {
    const actionResult = await sendTelegramOpenClawActionPlan({
      entry,
      telegram,
      fetchImpl: telegramFetch
    });
    const candidateResult = await sendTelegramReadwiseCandidateReviewMessages({
      entry,
      telegram,
      fetchImpl: telegramFetch
    });
    const actionMessageIds = actionResult.messages.map((message) => message.message_id).filter(Boolean);
    const candidateMessageIds = candidateResult.messages.map((message) => message.message_id).filter(Boolean);
    if ((!actionMessageIds.length && !candidateMessageIds.length) || !highlightStore) return entry;

    return highlightStore.set(
      entry.id,
      withTelegramProcessedMessageMetadata(entry.draft, {
        chatId: actionResult.messages[0]?.chat?.id || candidateResult.messages[0]?.chat?.id || telegram.chatId,
        actionMessageIds,
        candidateMessageIds,
        candidateTokens: candidateResult.tokens
      })
    );
  } catch (error) {
    console.warn(`Readwise Telegram processed notification failed: ${error.message || error}`);
    return entry;
  }
}

async function sendTelegramOpenClawActionPlan({ entry, telegram, fetchImpl = fetch } = {}) {
  const text = formatTelegramOpenClawActionPlanText(entry);
  if (!text) return { ok: true, mode: 'openclaw_action_plan', status: 0, messages: [] };

  const response = await fetchImpl(telegramApiUrl(telegram.token, 'sendMessage'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegram.chatId,
      text: truncateTelegramText(text, 3900),
      disable_web_page_preview: true
    })
  });
  if (!response.ok) throw new Error(`Telegram OpenClaw action send failed: ${response.status} ${await safeResponseText(response)}`);
  const payload = await safeResponseJson(response);
  return {
    ok: true,
    mode: 'openclaw_action_plan',
    status: response.status,
    messages: payload?.result ? [payload.result] : []
  };
}

async function sendTelegramReadwiseCandidateReviewMessages({ entry, telegram, fetchImpl = fetch } = {}) {
  const sentTokens = new Set(entry?.draft?.metadata?.telegramProcessed?.candidateTokens || []);
  const unsentCandidates = listReadwiseGeneratedCandidates(entry).filter((candidate) => !sentTokens.has(candidate.token));
  const limit = getReadwiseTelegramCandidateLimit();
  const noteCandidates = unsentCandidates.filter((candidate) => candidate.type === 'note');
  const highlightCandidates = unsentCandidates.filter((candidate) => candidate.type !== 'note');
  const candidates = [
    ...highlightCandidates.slice(0, Math.max(0, limit - noteCandidates.length)),
    ...noteCandidates
  ].slice(0, limit);
  const messages = [];
  const tokens = [];

  for (const candidate of candidates) {
    const response = await fetchImpl(telegramApiUrl(telegram.token, 'sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegram.chatId,
        text: truncateTelegramText(formatTelegramReadwiseCandidateText(candidate), 3900),
        reply_markup: buildTelegramReadwiseCandidateReplyMarkup(candidate),
        disable_web_page_preview: true
      })
    });
    if (!response.ok) throw new Error(`Telegram Readwise candidate send failed: ${response.status} ${await safeResponseText(response)}`);
    const payload = await safeResponseJson(response);
    if (payload?.result) messages.push(payload.result);
    tokens.push(candidate.token);
  }

  return { ok: true, mode: 'candidate_review_messages', messages, tokens };
}

async function sendTelegramVideoStreamMessage({ mode, sessionId, state = {}, reviewUrl = '', telegram, fetchImpl = fetch }) {
  if (!telegram.enabled) return { ok: false, skipped: telegram.reason };

  const text = formatTelegramVideoStreamText({ mode, sessionId, state, reviewUrl });
  const replyMarkup = buildTelegramVideoStreamReplyMarkup(state, reviewUrl);
  const response = await fetchImpl(telegramApiUrl(telegram.token, 'sendMessage'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegram.chatId,
      text: truncateTelegramText(text, 3900),
      reply_markup: replyMarkup.inline_keyboard.length ? replyMarkup : undefined,
      disable_web_page_preview: false
    })
  });

  if (!response.ok) throw new Error(`Telegram stream message failed: ${response.status} ${await safeResponseText(response)}`);
  const payload = await safeResponseJson(response);
  return { ok: true, mode: 'stream_message', status: response.status, message: payload?.result || null };
}

function formatTelegramVideoStreamText({ mode, sessionId, state = {}, reviewUrl = '' }) {
  const lines = [
    mode === 'stopped' ? 'Readwise video stream stopped' : 'Readwise video stream started',
    '',
    `Session: ${String(sessionId || 'unknown')}`,
    state.streamId ? `Stream: ${state.streamId}` : '',
    state.startedAt ? `Started: ${state.startedAt}` : '',
    state.stoppedAt ? `Stopped: ${state.stoppedAt}` : '',
    state.recording?.status ? `Recording: ${state.recording.status}` : '',
    state.recording?.url ? `Video: ${state.recording.url}` : '',
    state.recording?.audioUrl ? `Audio: ${state.recording.audioUrl}` : '',
    state.recording?.highlightId ? `Review draft: ${state.recording.highlightId}` : '',
    reviewUrl ? `Review: ${reviewUrl}` : '',
    '',
    mode === 'stopped'
      ? 'If the recording was saved, open the Readwise draft and process/review it later.'
      : 'Double/long press again to stop and save the video.'
  ];
  return lines.filter(Boolean).join('\n');
}

function buildTelegramVideoStreamReplyMarkup(state = {}, reviewUrl = '') {
  const buttons = [
    videoStreamUrlButton('Open Video', state.recording?.url),
    videoStreamUrlButton('Open Audio', state.recording?.audioUrl),
    videoStreamUrlButton('Open Review', reviewUrl)
  ].filter(Boolean);

  const rows = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2));
  }
  return { inline_keyboard: rows };
}

function videoStreamUrlButton(text, url) {
  if (!isHttpUrl(url)) return null;
  return { text, url };
}

function getReadwiseTelegramConfig() {
  if (process.env.READWISE_TELEGRAM_ENABLED === '0') return { enabled: false, reason: 'disabled' };
  const token = process.env.READWISE_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || process.env.WIP_TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.READWISE_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || process.env.WIP_TELEGRAM_CHAT_ID || '';
  if (!token || !chatId) return { enabled: false, reason: 'missing_config' };
  return { enabled: true, token, chatId };
}

function formatTelegramReadwiseDraftText(entry, reviewUrl = '') {
  const draft = entry.draft || {};
  const sourceLabel = draft.sourceKind === 'book_video' ? 'Book video' : 'Book page';
  const lines = [
    draft.sourceKind === 'book_video' ? 'Alerio Readwise recording saved' : 'Readwise draft pending',
    '',
    `Source: ${sourceLabel}`,
    `Status: ${draft.processing?.mode || 'pending_approval'}`,
    '',
    draft.highlight?.text ? draft.highlight.text : 'Recorded media is stored for later processing.',
    draft.highlight?.note ? `\nNote: ${draft.highlight.note}` : '',
    draft.videoUrl ? `\nVideo: ${draft.videoUrl}` : '',
    draft.audioUrl ? `\nAudio: ${draft.audioUrl}` : '',
    draft.imageUrl ? `\nImage: ${draft.imageUrl}` : '',
    reviewUrl ? `\nReview: ${reviewUrl}` : '',
    '',
    draft.sourceKind === 'book_video'
      ? 'Use the separate worker/code path to extract frames, transcribe audio, and build highlights.'
      : 'Approve only after the text is correct.'
  ];
  return lines.filter(Boolean).join('\n');
}

function buildTelegramReadwiseReplyMarkup(entry, reviewUrl = '') {
  const draft = entry.draft || {};
  const keyboard = [];
  if (reviewUrl) keyboard.push([{ text: 'Open Review', url: reviewUrl }]);
  if (draft.videoUrl) keyboard.push([{ text: 'Open Video', url: draft.videoUrl }]);
  if (draft.audioUrl) keyboard.push([{ text: 'Open Audio', url: draft.audioUrl }]);
  if (draft.imageUrl) keyboard.push([{ text: 'Open Image', url: draft.imageUrl }]);
  return { inline_keyboard: keyboard };
}

async function resolveReadwiseCandidateFromToken(token = '', { highlightStore } = {}) {
  if (!token || !highlightStore) return null;
  const entries = await highlightStore.list();
  for (const entry of entries) {
    const candidate = listReadwiseGeneratedCandidates(entry).find((item) => item.token === token);
    if (candidate) {
      return {
        entry,
        candidate,
        review: entry.draft?.metadata?.readwiseCandidateReviews?.[token] || null
      };
    }
  }
  return null;
}

function listReadwiseGeneratedCandidates(entry = {}) {
  const draft = entry.draft || {};
  const bookIdentity = getDraftBookIdentity(draft);
  const candidates = [];
  const extractedHighlights = Array.isArray(draft.extractedHighlights) ? draft.extractedHighlights : [];
  for (const [index, highlight] of extractedHighlights.entries()) {
    const text = normalizeNoteText(highlight?.text || '');
    if (!text) continue;
    const frameIndex = Number.isFinite(Number(highlight?.frameIndex)) ? Number(highlight.frameIndex) : null;
    const voiceThought = buildGeneratedCandidateNote(draft);
    const title = normalizeNoteText(bookIdentity.title || highlight?.title || draft.highlight?.title || draft.ocr?.title || '');
    const author = normalizeNoteText(bookIdentity.author || highlight?.author || draft.highlight?.author || draft.ocr?.author || '');
    const requiresBookIdentity = !isCompleteReadwiseBookIdentity({ title, author });
    const candidate = {
      entryId: entry.id,
      type: 'highlight',
      sourceKind: 'book_pen',
      index,
      text,
      page: normalizeNoteText(highlight?.page || ''),
      note: normalizeNoteText(highlight?.note || ''),
      voiceThought,
      marker: normalizeNoteText(highlight?.marker || ''),
      confidence: Number.isFinite(Number(highlight?.confidence)) ? Number(highlight.confidence) : null,
      title,
      author,
      requiresBookIdentity,
      bookIdentitySource: bookIdentity.source || '',
      frameUrl: frameIndex !== null ? draft.frameUrls?.[frameIndex] || '' : '',
      payload: requiresBookIdentity
        ? null
        : buildReadwiseCandidatePayload({
            title,
            author,
            page: normalizeReadwiseCandidatePage(highlight?.page),
            text,
            note: normalizeNoteText(highlight?.note || '')
          })
    };
    candidates.push({ ...candidate, token: readwiseCandidateCallbackToken(candidate) });
  }

  const noteText = getGeneratedReadwiseNoteCandidateText(draft);
  if (process.env.READWISE_TELEGRAM_GENERATED_NOTES !== '0' && noteText) {
    const candidate = {
      entryId: entry.id,
      type: 'note',
      sourceKind: 'voice_thought',
      index: 0,
      text: noteText,
      note: '',
      page: '',
      frameUrl: draft.frameUrls?.[0] || draft.imageUrl || '',
      payload: null
    };
    candidates.push({ ...candidate, token: readwiseCandidateCallbackToken(candidate) });
  }

  return candidates;
}

async function approveReadwiseTelegramCandidate({ entry, candidate, callback, highlightStore, fetchImpl = fetch } = {}) {
  if (candidate.requiresBookIdentity) {
    await answerTelegramReadwiseCallback({
      callback,
      text: 'Book title/author required before Readwise approval.',
      fetchImpl
    });
    await editTelegramReadwiseCallbackMessage({
      callback,
      text: formatTelegramReadwiseCandidateNeedsBookText(candidate),
      fetchImpl
    });
    return { status: 'blocked_book_identity', id: entry.id };
  }

  let result = {
    mode: 'review_only',
    target: candidate.type,
    wouldSend: candidate.payload || null
  };

  if (candidate.type === 'highlight') {
    if (!isReadwiseApprovalEnabled()) {
      throw new Error('readwise_approval_disabled');
    }
    result = await sendReadwiseHighlight({
      payload: candidate.payload,
      token: process.env.READWISE_TOKEN,
      liveWrites: process.env.READWISE_LIVE_WRITES === '1'
    });
  }

  await highlightStore.set(entry.id, withReadwiseCandidateReview(entry.draft, candidate, {
    status: 'approved',
    resultMode: result?.mode || 'live',
    reviewedAt: new Date().toISOString()
  }));
  await answerTelegramReadwiseCallback({
    callback,
    text: candidate.type === 'note' ? 'Note kept.' : 'Highlight approved.',
    fetchImpl
  });
  await editTelegramReadwiseCallbackMessage({
    callback,
    text: formatTelegramReadwiseCandidateFinalText(candidate, { status: 'approved', result }),
    fetchImpl
  });
  return { status: 'approved', id: entry.id, result };
}

async function rejectReadwiseTelegramCandidate({ entry, candidate, callback, highlightStore, fetchImpl = fetch } = {}) {
  await highlightStore.set(entry.id, withReadwiseCandidateReview(entry.draft, candidate, {
    status: 'rejected',
    reviewedAt: new Date().toISOString()
  }));
  await answerTelegramReadwiseCallback({
    callback,
    text: candidate.type === 'note' ? 'Note rejected.' : 'Highlight rejected.',
    fetchImpl
  });
  await editTelegramReadwiseCallbackMessage({
    callback,
    text: formatTelegramReadwiseCandidateFinalText(candidate, { status: 'rejected' }),
    fetchImpl
  });
  return { status: 'rejected', id: entry.id };
}

function withReadwiseCandidateReview(draft = {}, candidate = {}, review = {}) {
  return {
    ...draft,
    metadata: {
      ...(draft.metadata || {}),
      readwiseCandidateReviews: {
        ...(draft.metadata?.readwiseCandidateReviews || {}),
        [candidate.token]: {
          type: candidate.type,
          index: candidate.index,
          text: candidate.text,
          ...(candidate.page ? { page: candidate.page } : {}),
          status: review.status,
          ...(review.resultMode ? { resultMode: review.resultMode } : {}),
          reviewedAt: review.reviewedAt
        }
      }
    }
  };
}

async function answerTelegramReadwiseCallback({ callback, text = '', fetchImpl = fetch } = {}) {
  const telegram = getReadwiseTelegramConfig();
  if (!telegram.enabled || !callback?.id) return null;
  const response = await fetchImpl(telegramApiUrl(telegram.token, 'answerCallbackQuery'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callback.id,
      text: truncateTelegramText(text, 200)
    })
  });
  if (!response.ok) throw new Error(`Telegram callback answer failed: ${response.status} ${await safeResponseText(response)}`);
  return safeResponseJson(response);
}

async function editTelegramReadwiseCallbackMessage({ callback, text = '', fetchImpl = fetch } = {}) {
  const telegram = getReadwiseTelegramConfig();
  const chatId = callback?.message?.chat?.id;
  const messageId = callback?.message?.message_id;
  if (!telegram.enabled || !chatId || !messageId) return null;
  const response = await fetchImpl(telegramApiUrl(telegram.token, 'editMessageText'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: String(messageId),
      text,
      reply_markup: { inline_keyboard: [] },
      disable_web_page_preview: true
    })
  });
  if (!response.ok) throw new Error(`Telegram message edit failed: ${response.status} ${await safeResponseText(response)}`);
  return safeResponseJson(response);
}

function parseReadwiseTelegramCallback(data = '') {
  const match = String(data || '').match(/^rw:([ar]):([a-zA-Z0-9_-]{8,32})$/);
  if (!match) return null;
  return {
    action: { a: 'approve', r: 'reject' }[match[1]],
    token: match[2]
  };
}

function readwiseCandidateCallbackToken(candidate = {}) {
  return createHash('sha256')
    .update([candidate.entryId, candidate.type, candidate.index, candidate.text, candidate.page || ''].join(':'))
    .digest('base64url')
    .slice(0, 16);
}

function buildReadwiseCandidatePayload({ title, author, page, text, note } = {}) {
  return {
    endpoint: 'POST https://readwise.io/api/v2/highlights/',
    body: {
      highlights: [
        {
          text,
          title,
          author,
          source_type: 'mentra_live',
          category: 'books',
          location_type: 'page',
          location: Number.isFinite(Number(page)) ? Number(page) : null,
          note: note || ''
        }
      ]
    }
  };
}

function formatTelegramReadwiseCandidateText(candidate = {}) {
  const isNote = candidate.type === 'note';
  const lines = [
    isNote ? 'Voice thought review' : 'Readwise highlight review',
    '',
    `Source: ${isNote ? 'Voice thought' : 'Book pen'}`,
    !isNote && candidate.requiresBookIdentity ? 'Book: missing title/author - approval blocked' : '',
    !isNote && !candidate.requiresBookIdentity ? `Book: ${candidate.title}` : '',
    !isNote && !candidate.requiresBookIdentity ? `Author: ${candidate.author}` : '',
    !isNote && candidate.bookIdentitySource === 'reading_context' ? 'Book source: active reading context' : '',
    !isNote && candidate.bookIdentitySource === 'reading_context_history' ? 'Book source: reading history match' : '',
    !isNote && candidate.page ? `Page: ${candidate.page}` : '',
    !isNote && candidate.marker ? `Mark: ${candidate.marker}` : '',
    !isNote && candidate.confidence !== null ? `Confidence: ${Math.round(Number(candidate.confidence) * 100)}%` : '',
    '',
    candidate.text,
    '',
    !isNote && candidate.voiceThought ? `Voice thought: ${candidate.voiceThought}` : '',
    isNote
      ? 'Approving keeps this note with the draft. It is separate from Readwise highlights.'
      : candidate.requiresBookIdentity
        ? 'Approval is blocked until the book title and author are detected or entered.'
        : 'Approve sends this highlight to Readwise. Reject discards only this candidate.'
  ];
  return lines.filter(Boolean).join('\n');
}

function formatTelegramReadwiseCandidateNeedsBookText(candidate = {}) {
  return [
    'Book metadata required',
    '',
    candidate.text,
    '',
    'This highlight was not sent to Readwise because the book title/author are missing.',
    'Record the cover/title page or add the book metadata before approving.'
  ].join('\n');
}

function buildTelegramReadwiseCandidateReplyMarkup(candidate = {}) {
  const approveText = candidate.type === 'note' ? 'Keep Note' : 'Approve Highlight';
  return {
    inline_keyboard: [
      [
        { text: approveText, callback_data: `rw:a:${candidate.token}` },
        { text: 'Reject', callback_data: `rw:r:${candidate.token}` }
      ]
    ]
  };
}

function formatTelegramReadwiseCandidateFinalText(candidate = {}, { status = '', result = null } = {}) {
  const action = status === 'approved' ? 'Approved' : 'Rejected';
  const isNote = candidate.type === 'note';
  const lines = [
    `${action} ${isNote ? 'voice thought' : 'book pen highlight'}`,
    '',
    candidate.text,
    '',
    !isNote && candidate.page ? `Page: ${candidate.page}` : '',
    !isNote && candidate.marker ? `Mark: ${candidate.marker}` : '',
    !isNote && candidate.voiceThought ? `Voice thought captured separately: ${candidate.voiceThought}` : '',
    !isNote && candidate.note ? `Book note: ${candidate.note}` : '',
    result?.mode ? `\nMode: ${result.mode}` : ''
  ];
  return truncateTelegramText(lines.filter(Boolean).join('\n'), 3900);
}

function formatTelegramOpenClawActionPlanText(entry = {}) {
  if (!shouldSendOpenClawActionPlan(entry)) return '';
  const actions = extractOpenClawActions(getGeneratedReadwiseNoteCandidateText(entry.draft || {}));
  if (!actions.length) return '';
  const actionLabel = actions.length === 1 ? '1 action' : `${actions.length} actions`;
  const bookIdentity = getDraftBookIdentity(entry.draft || {});
  const bookLine = isCompleteReadwiseBookIdentity(bookIdentity)
    ? `Current book: ${bookIdentity.title} by ${bookIdentity.author}${bookIdentity.source === 'reading_context' ? ' (active context)' : ''}${bookIdentity.source === 'reading_context_history' ? ' (history match)' : ''}`
    : '';
  return [
    'OpenClaw action plan',
    '',
    ...(bookLine ? [bookLine, ''] : []),
    `I will take ${actionLabel} from your voice note:`,
    ...actions.map((action, index) => `${index + 1}. ${action}`),
    '',
    'This is separate from the book-pen Readwise highlights.'
  ].join('\n');
}

function buildGeneratedCandidateNote(draft = {}) {
  const note = getGeneratedReadwiseNoteCandidateText(draft);
  if (note) return note;
  return normalizeNoteText(draft.highlight?.note || '');
}

function getGeneratedReadwiseNoteCandidateText(draft = {}) {
  const note = normalizeNoteText(String(draft.highlight?.note || '').split(/\s*Decision:/i)[0] || '');
  if (note.length < 12) return '';
  return note;
}

function shouldSendOpenClawActionPlan(entry = {}) {
  if (process.env.READWISE_TELEGRAM_OPENCLAW_ACTIONS === '0') return false;
  if (entry?.draft?.sourceKind !== 'book_video') return false;
  return extractOpenClawActions(getGeneratedReadwiseNoteCandidateText(entry.draft || {})).length > 0;
}

function extractOpenClawActions(note = '') {
  const text = normalizeNoteText(note);
  if (!text) return [];
  return String(text)
    .split(/(?:\s*[.!?]\s+|\s*;\s+|\n+)/)
    .map(cleanOpenClawActionSentence)
    .filter((sentence) => sentence.length >= 8)
    .filter(isOpenClawActionSentence)
    .filter((sentence, index, sentences) => {
      const normalized = sentence.toLowerCase();
      return sentences.findIndex((candidate) => candidate.toLowerCase() === normalized) === index;
    })
    .slice(0, getOpenClawActionLimit());
}

function isOpenClawActionSentence(sentence = '') {
  return /\b(openclaw|please|remind|reminder|set|ask me|send|email|create|draft|check|look up|research|schedule|make|build|post|notify|follow up|turn on|set up|write|prepare|summari[sz]e)\b/i.test(sentence);
}

function cleanOpenClawActionSentence(sentence = '') {
  return normalizeNoteText(sentence)
    .replace(/^openclaw[,:\s-]*/i, '')
    .replace(/^please\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .trim();
}

function getOpenClawActionLimit() {
  const parsed = Number(process.env.READWISE_TELEGRAM_OPENCLAW_ACTION_LIMIT || 5);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(10, Math.floor(parsed)) : 5;
}

function getReadwiseTelegramCandidateLimit() {
  const parsed = Number(process.env.READWISE_TELEGRAM_CANDIDATE_LIMIT || 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(20, Math.floor(parsed)) : 10;
}

function normalizeReadwiseCandidatePage(value = '') {
  const text = String(value || '').trim();
  const numeric = Number(text.replace(/[^\d.]/g, ''));
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : null;
}

function getDraftBookIdentity(draft = {}) {
  const identity = draft.metadata?.bookIdentity || {};
  return {
    title: normalizeBookIdentityField(identity.title),
    author: normalizeBookIdentityField(identity.author),
    status: normalizeBookIdentityField(identity.status),
    source: normalizeBookIdentityField(identity.source)
  };
}

function isCompleteReadwiseBookIdentity(identity = {}) {
  return Boolean(normalizeBookIdentityField(identity.title) && normalizeBookIdentityField(identity.author));
}

function normalizeBookIdentityField(value = '') {
  return normalizeNoteText(value)
    .replace(/^unknown\b.*$/i, '')
    .replace(/^null$/i, '')
    .trim();
}

function normalizeReadingContextBook(book = {}) {
  if (!book || typeof book !== 'object') return null;
  const title = normalizeBookIdentityField(book.title);
  const author = normalizeBookIdentityField(book.author);
  if (!title || !author) return null;
  const status = normalizeBookIdentityField(book.status) || 'active';
  const source = normalizeBookIdentityField(book.source) || 'detected';
  const firstSeenAt = normalizeIsoDate(book.firstSeenAt);
  const lastSeenAt = normalizeIsoDate(book.lastSeenAt);
  const lastDraftId = normalizeNoteText(book.lastDraftId || '').slice(0, 160);
  const lastPage = normalizeNoteText(book.lastPage || '').slice(0, 40);
  const seenCount = Number(book.seenCount);
  const pages = uniqueStrings(Array.isArray(book.pages) ? book.pages.map((page) => normalizeNoteText(page).slice(0, 40)) : []);
  const recentDraftIds = uniqueStrings(
    Array.isArray(book.recentDraftIds) ? book.recentDraftIds.map((draftId) => normalizeNoteText(draftId).slice(0, 160)) : []
  );
  return {
    title,
    author,
    status,
    source,
    ...(firstSeenAt ? { firstSeenAt } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(Number.isFinite(seenCount) && seenCount > 0 ? { seenCount: Math.floor(seenCount) } : {}),
    ...(pages.length ? { pages } : {}),
    ...(recentDraftIds.length ? { recentDraftIds } : {}),
    ...(lastDraftId ? { lastDraftId } : {}),
    ...(lastPage ? { lastPage } : {})
  };
}

function sameReadingContextBook(left = {}, right = {}) {
  return bookIdentityKey(left) === bookIdentityKey(right);
}

function bookIdentityKey(identity = {}) {
  return `${normalizeBookIdentityField(identity.title).toLowerCase()}::${normalizeBookIdentityField(identity.author).toLowerCase()}`;
}

function normalizeIsoDate(value = '') {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function isReadwiseApprovalEnabled() {
  return process.env.READWISE_APPROVAL_ENABLED === '1';
}

function withTelegramDraftMessageMetadata(draft, { chatId, messageId, mode = '' } = {}) {
  if (!chatId || !messageId) return draft;
  return {
    ...draft,
    metadata: {
      ...(draft.metadata || {}),
      telegram: {
        chatId: String(chatId),
        messageId: String(messageId),
        ...(mode ? { mode } : {})
      }
    }
  };
}

function withTelegramProcessedMessageMetadata(draft, { chatId, actionMessageIds = [], candidateMessageIds = [], candidateTokens = [] } = {}) {
  if (!chatId || (!actionMessageIds.length && !candidateMessageIds.length)) return draft;
  const existing = draft.metadata?.telegramProcessed || {};
  return {
    ...draft,
    metadata: {
      ...(draft.metadata || {}),
      telegramProcessed: {
        ...existing,
        chatId: String(chatId),
        actionMessageIds: uniqueStrings([...(existing.actionMessageIds || []), ...actionMessageIds]),
        candidateMessageIds: uniqueStrings([...(existing.candidateMessageIds || []), ...candidateMessageIds]),
        candidateTokens: uniqueStrings([...(existing.candidateTokens || []), ...candidateTokens])
      }
    }
  };
}

function uniqueStrings(values = []) {
  return Array.from(new Set(values.map(String).filter(Boolean)));
}

function telegramApiUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function safeResponseJson(response) {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

async function safeResponseText(response) {
  try {
    return await response.text();
  } catch (_error) {
    return '';
  }
}

function truncateTelegramText(text, limit) {
  const value = String(text || '');
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function bearerToken(value = '') {
  const match = String(value || '').match(/^Bearer\s+(.+)$/i);
  return match?.[1] || '';
}

function bodyBridgeToken(body) {
  if (!body || typeof body !== 'object') return '';
  return typeof body.bridgeToken === 'string' ? body.bridgeToken : '';
}

function normalizeBasePath(prefix) {
  const cleaned = String(prefix || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return cleaned ? `/${cleaned}` : '';
}

function getPublicAssetUrl(request, filename) {
  const base = process.env.PUBLIC_URL || getBasePath(request) || '';
  return `${base.replace(/\/$/, '')}/assets/${encodeURIComponent(filename)}`;
}

function renderReviewPage({ basePath = '', entries = [], status = '', error = '' } = {}) {
  const statusText = {
    approved: 'Approved.',
    rejected: 'Rejected.',
    drafted: 'Draft saved.',
    queued: 'Video queued for worker processing.'
  }[status];

  const rows = entries
    .map((entry) => {
      const id = encodeURIComponent(entry.id);
      const media = renderDraftMedia(entry.draft);
      const trace = renderTraceMetadata(entry.draft.metadata);
      const processing = renderProcessingState(entry.draft.processing);
      const meta = [entry.draft.ocr?.title, entry.draft.ocr?.author, entry.draft.ocr?.page ? `p. ${entry.draft.ocr.page}` : '']
        .filter(Boolean)
        .join(' · ');
      const processVideoAction =
        entry.draft.sourceKind === 'book_video'
          ? `
            <form method="post" action="${basePath}/webhooks/mentra/book-page/${id}/process-video">
              <button class="process" type="submit">Process Video</button>
            </form>`
          : '';

      return `
        <article class="draft">
          <div class="meta">
            <time datetime="${escapeAttribute(entry.createdAt)}">${formatDate(entry.createdAt)}</time>
            <span>${escapeHtml(entry.draft.sourceKind === 'book_video' ? 'Video capture' : 'Page capture')}</span>
          </div>
          ${media}
          ${trace}
          <h2>${escapeHtml(meta || 'Book page')}</h2>
          <p>${escapeHtml(entry.draft.highlight?.text || 'Review captured image before approving.')}</p>
          ${entry.draft.highlight?.note ? `<p class="note">${escapeHtml(entry.draft.highlight.note)}</p>` : ''}
          ${processing}
          <div class="actions">
            ${processVideoAction}
            <form method="post" action="${basePath}/webhooks/mentra/book-page/${id}/approve">
              <button class="approve" type="submit">Approve</button>
            </form>
            <form method="post" action="${basePath}/webhooks/mentra/book-page/${id}/reject">
              <button class="reject" type="submit">Reject</button>
            </form>
          </div>
        </article>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" href="${basePath}/favicon.ico">
    <title>Mentra Readwise Review</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f7f2;
        --ink: #1f2328;
        --muted: #68727d;
        --line: #d9d8cf;
        --panel: #fffefa;
        --accent: #2f5fb3;
        --approve: #0f766e;
        --reject: #b42318;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--ink);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.45;
      }

      main {
        width: min(780px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 48px;
      }

      header {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 18px;
      }

      h1 {
        margin: 0;
        font-size: clamp(1.7rem, 5vw, 2.35rem);
        letter-spacing: 0;
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
      }

      .brand-copy {
        display: grid;
        gap: 4px;
        min-width: 0;
      }

      .brand-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
      }

      .logo-mark {
        display: inline-flex;
        align-items: center;
        min-height: 22px;
        border: 1px solid #fbbf24;
        border-radius: 6px;
        background: #1f5b3b;
        color: #fff8e8;
        font-size: 0.72rem;
        font-weight: 800;
        letter-spacing: 0;
        padding: 2px 7px;
      }

      .brand-subtitle {
        color: var(--muted);
        font-size: 0.9rem;
      }

      .app-icon {
        width: 48px;
        height: 48px;
        border-radius: 8px;
        flex: 0 0 auto;
      }

      h2 {
        margin: 10px 0 0;
        font-size: 1rem;
      }

      .count,
      .meta,
      label {
        color: var(--muted);
        font-size: 0.9rem;
      }

      .composer,
      .draft {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
      }

      .composer {
        display: grid;
        gap: 10px;
        margin-bottom: 18px;
        padding: 14px;
      }

      textarea,
      input {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: #ffffff;
        color: var(--ink);
        font: inherit;
        padding: 10px;
      }

      textarea {
        min-height: 118px;
        resize: vertical;
      }

      .composer button,
      .actions button {
        min-height: 40px;
        border: 0;
        border-radius: 6px;
        color: #ffffff;
        cursor: pointer;
        font: inherit;
        font-weight: 700;
        padding: 0 16px;
      }

      .composer button {
        justify-self: end;
        background: var(--accent);
      }

      .drafts {
        display: grid;
        gap: 12px;
      }

      .draft {
        padding: 14px;
      }

      .meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .media {
        color: var(--accent);
        font-weight: 700;
      }

      .media-list {
        display: grid;
        gap: 8px;
        margin-top: 12px;
      }

      .frame-list {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .frame-list a,
      .source-video {
        border: 1px solid var(--line);
        border-radius: 6px;
        color: var(--accent);
        font-weight: 700;
        padding: 6px 9px;
        text-decoration: none;
      }

      .trace {
        color: var(--muted);
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 10px;
      }

      .trace span {
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 3px 8px;
      }

      p {
        margin: 12px 0;
        overflow-wrap: anywhere;
      }

      .note {
        color: var(--muted);
      }

      .actions {
        display: flex;
        gap: 10px;
        margin-top: 14px;
      }

      .actions form {
        flex: 1;
      }

      .actions button {
        width: 100%;
      }

      .approve { background: var(--approve); }
      .reject { background: var(--reject); }
      .process { background: #475569; }

      .notice,
      .empty {
        border-radius: 8px;
        padding: 10px 12px;
      }

      .notice {
        margin: 0 0 14px;
      }

      .ok {
        background: #dff7ef;
        color: #075446;
      }

      .error {
        background: #fee4e2;
        color: #8a1f16;
      }

      .empty {
        border: 1px dashed var(--line);
        color: var(--muted);
        padding: 28px 14px;
        text-align: center;
      }

      @media (max-width: 520px) {
        main {
          width: min(100vw - 20px, 780px);
          padding-top: 16px;
        }

        header,
        .meta,
        .actions {
          align-items: stretch;
          flex-direction: column;
        }

        .composer button {
          justify-self: stretch;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div class="brand">
          <img class="app-icon" src="${basePath}/assets/app-icon.svg" alt="Mentra Book Readwise logo">
          <div class="brand-copy">
            <h1>Mentra Readwise Review</h1>
            <div class="brand-row">
              <span class="logo-mark">BOOK</span>
              <span class="brand-subtitle">Book page OCR to Readwise draft</span>
            </div>
          </div>
        </div>
        <div class="count">${entries.length} pending</div>
      </header>
      ${statusText ? `<p class="notice ok">${escapeHtml(statusText)}</p>` : ''}
      ${error ? `<p class="notice error">${escapeHtml(error)}</p>` : ''}
      <form class="composer" method="post" action="${basePath}/webhooks/mentra/book-video" enctype="multipart/form-data">
        ${process.env.MENTRA_BRIDGE_TOKEN ? `
        <label for="bridgeTokenVideo">Bridge token</label>
        <input id="bridgeTokenVideo" name="bridgeToken" type="password" autocomplete="off" required>` : ''}
        <label for="video">Book video</label>
        <input id="video" name="video" type="file" accept="video/*">
        <label for="transcript">Voice note / context</label>
        <textarea id="transcript" name="transcript" placeholder="What you were thinking while reading"></textarea>
        <button type="submit">Draft Video</button>
      </form>
      <form class="composer" method="post" action="${basePath}/webhooks/mentra/book-page">
        ${process.env.MENTRA_BRIDGE_TOKEN ? `
        <label for="bridgeToken">Bridge token</label>
        <input id="bridgeToken" name="bridgeToken" type="password" autocomplete="off" required>` : ''}
        <label for="ocrText">OCR Text</label>
        <textarea id="ocrText" name="ocrText" placeholder="[HIGHLIGHT] ..." required></textarea>
        <label for="imageUrl">Image URL</label>
        <input id="imageUrl" name="imageUrl" type="url" placeholder="https://">
        <button type="submit">Draft</button>
      </form>
      <section class="drafts">
        ${rows || '<div class="empty">No pending highlights.</div>'}
      </section>
    </main>
  </body>
</html>`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}

function extractTraceMetadata(request, requestPrefix) {
  const requestId = request.body?.requestId || request.body?.id || '';
  return {
    requestId,
    testRunId: request.body?.testRunId || inferTestRunId(requestId, requestPrefix)
  };
}

function inferTestRunId(requestId = '', requestPrefix = '') {
  const safePrefix = String(requestPrefix || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const match = String(requestId || '').match(new RegExp(`^(.+)_${safePrefix}_\\d+$`));
  return match?.[1] || '';
}

function renderTraceMetadata(metadata = {}) {
  const parts = [
    metadata.testRunId ? `Test run: ${metadata.testRunId}` : '',
    metadata.requestId ? `Request: ${metadata.requestId}` : ''
  ].filter(Boolean);
  if (!parts.length) return '';
  return `<div class="trace">${parts.map((part) => `<span>${escapeHtml(part)}</span>`).join('')}</div>`;
}

function renderProcessingState(processing = {}) {
  if (!processing?.mode) return '';
  const parts = [
    `Processing: ${processing.mode}`,
    Number.isFinite(Number(processing.frameCount)) ? `Frames: ${Number(processing.frameCount)}` : '',
    processing.reason ? `Reason: ${processing.reason}` : ''
  ].filter(Boolean);
  return `<p class="note">${escapeHtml(parts.join(' · '))}</p>`;
}

function renderDraftMedia(draft = {}) {
  const links = [];
  if (draft.videoUrl) {
    links.push(`<a class="source-video" href="${escapeAttribute(draft.videoUrl)}" target="_blank" rel="noreferrer">Open source video</a>`);
  }
  if (draft.audioUrl) {
    links.push(`<a class="source-video" href="${escapeAttribute(draft.audioUrl)}" target="_blank" rel="noreferrer">Open source audio</a>`);
  }
  if (draft.imageUrl) {
    links.push(`<a class="source-video" href="${escapeAttribute(draft.imageUrl)}" target="_blank" rel="noreferrer">Open primary frame</a>`);
  }

  const frames = (draft.frameUrls || [])
    .map(
      (url, index) =>
        `<a href="${escapeAttribute(url)}" target="_blank" rel="noreferrer">Frame ${index + 1}</a>`
    )
    .join('');
  const frameList = frames ? `<div class="frame-list">${frames}</div>` : '';
  if (!links.length && !frameList) return '';
  return `<div class="media-list">${links.join('')}${frameList}</div>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = new MentraBookReadwiseApp({
    packageName: process.env.MENTRA_PACKAGE_NAME || DEFAULT_PACKAGE_NAME,
    apiKey: process.env.MENTRA_API_KEY,
    port: Number(process.env.PORT || 3002),
    healthCheck: true
  });

  await app.start();
}

export { FileHighlightStore, FileReadingContextStore, LocalMediaStore, MentraBookReadwiseApp, notifyTelegramReadwiseProcessedDraft };
