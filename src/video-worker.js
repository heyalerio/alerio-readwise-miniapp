import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildApprovalDraft, buildReadwisePayload } from './domain.js';
import { FileHighlightStore, FileReadingContextStore, notifyTelegramReadwiseProcessedDraft } from './app.js';
import {
  extractAudioClipWithFfmpeg,
  fingerprintFrameWithFfmpeg,
  extractMarkedBookHighlights,
  extractVideoFramesWithFfmpeg,
  processBookVideo,
  selectLikelyBookFrames
} from './book-video-processor.js';

export {
  extractAudioClipWithFfmpeg,
  extractVideoFramesWithFfmpeg,
  extractMarkedBookHighlights,
  fingerprintFrameWithFfmpeg,
  processBookVideo,
  selectLikelyBookFrames
} from './book-video-processor.js';

export async function processQueuedVideoDrafts({
  highlightStore = new FileHighlightStore(),
  readingContextStore = new FileReadingContextStore(),
  mediaDir = process.env.MEDIA_DIR || path.join(process.cwd(), 'data', 'media'),
  publicBaseUrl = process.env.PUBLIC_URL || '',
  draftId = '',
  limit = getWorkerLimit(),
  includeStored = Boolean(draftId),
  frameExtractor = extractVideoFramesWithFfmpeg,
  frameSelector = selectLikelyBookFrames,
  frameScorer,
  frameFingerprinter = fingerprintFrameWithFfmpeg,
  frameEnhancer,
  frameOcrExtractor,
  frameHighlightExtractor = extractMarkedBookHighlights,
  videoProcessor = processBookVideo,
  audioExtractor = extractAudioClipWithFfmpeg,
  audioTranscriber,
  telegramFetch = fetch,
  telegramNotifier = notifyTelegramReadwiseProcessedDraft
} = {}) {
  const entries = await highlightStore.list();
  const targets = entries.filter((entry) => isProcessableVideoDraft(entry, { draftId, includeStored })).slice(0, limit);
  const results = [];

  for (const entry of targets) {
    results.push(
      await processQueuedVideoDraft({
        entry,
        highlightStore,
        readingContextStore,
        mediaDir,
        publicBaseUrl,
        frameExtractor,
        frameSelector,
        frameScorer,
        frameFingerprinter,
        frameEnhancer,
        frameOcrExtractor,
        frameHighlightExtractor,
        videoProcessor,
        audioExtractor,
        audioTranscriber,
        telegramFetch,
        telegramNotifier
      })
    );
  }

  return {
    scanned: entries.length,
    matched: targets.length,
    processed: results.filter((result) => result.status === 'processed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    results
  };
}

async function processQueuedVideoDraft({
  entry,
  highlightStore,
  readingContextStore,
  mediaDir,
  publicBaseUrl,
  frameExtractor,
  frameSelector,
  frameScorer,
  frameFingerprinter,
  frameEnhancer,
  frameOcrExtractor,
  frameHighlightExtractor,
  videoProcessor,
  audioExtractor,
  audioTranscriber,
  telegramFetch,
  telegramNotifier
}) {
  const draft = entry.draft;
  const videoPath = resolveStoredMediaPath(draft, mediaDir);
  const previousFrameCount = Number(draft.processing?.frameCount || 0);

  try {
    if (!videoPath) throw new Error('stored_video_not_found');
    await fs.access(videoPath);

    await highlightStore.set(entry.id, {
      ...draft,
      processing: {
        mode: 'processing',
        frameCount: previousFrameCount,
        reason: 'worker'
      }
    });

    const processedVideo = await videoProcessor({
      videoPath,
      mediaDir,
      publicBaseUrl,
      existingTranscript: draft.highlight?.note || '',
      frameExtractor,
      frameSelector,
      frameScorer,
      frameFingerprinter,
      frameEnhancer,
      frameOcrExtractor,
      frameHighlightExtractor,
      audioExtractor,
      audioTranscriber,
      label: 'book_frame'
    });
    const frameUrls = Array.isArray(processedVideo.frameUrls) ? processedVideo.frameUrls : [];
    const processing = processedVideo.processing || {};
    const updatedDraft = buildApprovalDraft({
      ocrText: processedVideo.ocrText,
      imageUrl: frameUrls[0] || draft.imageUrl || '',
      videoUrl: draft.videoUrl || draft.storage?.url || '',
      audioUrl: draft.audioUrl || draft.audioStorage?.url || '',
      frameUrls,
      extractedHighlights: processedVideo.extractedHighlights,
      sourceKind: 'book_video',
      note: processedVideo.reviewNote || processedVideo.transcript || draft.highlight?.note || '',
      requestId: draft.metadata?.requestId || '',
      testRunId: draft.metadata?.testRunId || '',
      storage: draft.storage,
      audioStorage: draft.audioStorage,
      processing: {
        mode: 'processed',
        ...processing
      }
    });
    updatedDraft.metadata = {
      ...(draft.metadata || {}),
      ...(updatedDraft.metadata || {}),
      ...(processedVideo.bookIdentity ? { bookIdentity: processedVideo.bookIdentity } : {})
    };

    const contextAwareDraft = await applyReadingContextToDraft(updatedDraft, {
      readingContextStore,
      entryId: entry.id
    });
    const saved = await highlightStore.set(entry.id, contextAwareDraft);
    if (telegramNotifier) {
      await telegramNotifier(saved, {
        reviewUrl: publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/review` : '',
        telegramFetch,
        highlightStore
      });
    }
    return { id: entry.id, status: 'processed', frameCount: processing.selectedFrameCount || frameUrls.length };
  } catch (error) {
    const reason = normalizeReason(error);
    await highlightStore.set(entry.id, {
      ...draft,
      processing: {
        mode: 'failed',
        frameCount: previousFrameCount,
        reason
      }
    });
    return { id: entry.id, status: 'failed', error: reason };
  }
}

async function applyReadingContextToDraft(draft, { readingContextStore, entryId = '' } = {}) {
  if (!readingContextStore) return draft;

  const detectedIdentity = normalizeWorkerBookIdentity(draft.metadata?.bookIdentity || {});
  if (isCompleteBookIdentity(detectedIdentity) && detectedIdentity.status === 'confirmed') {
    await readingContextStore.setActiveBook(detectedIdentity, {
      draftId: entryId,
      page: firstKnownPage(draft)
    });
    return applyBookIdentityToDraft(draft, detectedIdentity);
  }

  const contextMatch = await findReadingContextMatch({
    readingContextStore,
    detectedIdentity
  });
  if (!contextMatch) return draft;

  const contextAwareDraft = applyBookIdentityToDraft(draft, {
    title: contextMatch.book.title,
    author: contextMatch.book.author,
    status: contextMatch.status,
    source: contextMatch.source,
    required: false,
    contextDraftId: contextMatch.book.lastDraftId || '',
    contextLastSeenAt: contextMatch.book.lastSeenAt || '',
    contextMatchScore: contextMatch.score
  });
  await readingContextStore.setActiveBook(contextMatch.book, {
    draftId: entryId,
    page: firstKnownPage(contextAwareDraft)
  });
  return contextAwareDraft;
}

function applyBookIdentityToDraft(draft, identity = {}) {
  const normalized = normalizeWorkerBookIdentity(identity);
  if (!isCompleteBookIdentity(normalized)) return draft;

  const nextHighlight = {
    ...(draft.highlight || {}),
    title: normalized.title,
    author: normalized.author
  };
  const nextExtractedHighlights = Array.isArray(draft.extractedHighlights)
    ? draft.extractedHighlights.map((highlight) => ({
        ...highlight,
        title: normalizeWorkerBookIdentity(highlight).title || normalized.title,
        author: normalizeWorkerBookIdentity(highlight).author || normalized.author
      }))
    : draft.extractedHighlights;

  return {
    ...draft,
    ocr: {
      ...(draft.ocr || {}),
      title: normalized.title,
      author: normalized.author
    },
    highlight: nextHighlight,
    ...(Array.isArray(nextExtractedHighlights) ? { extractedHighlights: nextExtractedHighlights } : {}),
    readwisePayload: buildReadwisePayload(nextHighlight),
    processing: {
      ...(draft.processing || {}),
      bookIdentityStatus: normalized.status || draft.processing?.bookIdentityStatus,
      bookIdentitySource: normalized.source || draft.processing?.bookIdentitySource
    },
    metadata: {
      ...(draft.metadata || {}),
      bookIdentity: {
        ...(draft.metadata?.bookIdentity || {}),
        ...normalized
      }
    }
  };
}

async function findReadingContextMatch({ readingContextStore, detectedIdentity = {} } = {}) {
  const activeBook = await readingContextStore.getActiveBook();
  if (shouldUseReadingContextFallback(detectedIdentity, activeBook)) {
    return {
      book: activeBook,
      status: 'context_fallback',
      source: 'reading_context',
      score: detectedIdentity.title || detectedIdentity.author ? scoreBookIdentityMatch(detectedIdentity, activeBook) : 1
    };
  }

  const books = typeof readingContextStore.listBooks === 'function' ? await readingContextStore.listBooks() : [];
  const historyMatch = selectSimilarReadingContextBook(detectedIdentity, books);
  if (!historyMatch) return null;
  return {
    book: historyMatch.book,
    status: 'history_fallback',
    source: 'reading_context_history',
    score: historyMatch.score
  };
}

function shouldUseReadingContextFallback(identity = {}, activeBook = {}) {
  const active = normalizeWorkerBookIdentity(activeBook);
  if (!isCompleteBookIdentity(active)) return false;
  const detected = normalizeWorkerBookIdentity(identity);
  if (isCompleteBookIdentity(detected)) return false;
  if (!detected.title && !detected.author) return true;
  if (scoreBookIdentityMatch(detected, active) >= getReadingContextActiveMatchMinScore()) return true;
  return false;
}

function selectSimilarReadingContextBook(identity = {}, books = []) {
  const detected = normalizeWorkerBookIdentity(identity);
  if (!detected.title && !detected.author) return null;

  const ranked = (Array.isArray(books) ? books : [])
    .map((book) => ({ book: normalizeWorkerBookIdentity(book), score: scoreBookIdentityMatch(detected, book) }))
    .filter((candidate) => isCompleteBookIdentity(candidate.book))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < getReadingContextHistoryMatchMinScore()) return null;

  const second = ranked[1];
  if (second && best.score - second.score < getReadingContextHistoryMatchMargin()) return null;

  return best;
}

function scoreBookIdentityMatch(identity = {}, book = {}) {
  const detected = normalizeWorkerBookIdentity(identity);
  const candidate = normalizeWorkerBookIdentity(book);
  if (!isCompleteBookIdentity(candidate)) return 0;

  const titleScore = detected.title ? similarityScore(detected.title, candidate.title) : null;
  const authorScore = detected.author ? similarityScore(detected.author, candidate.author) : null;
  if (titleScore === null && authorScore === null) return 0;
  if (titleScore !== null && authorScore !== null) return titleScore * 0.7 + authorScore * 0.3;
  if (titleScore !== null) return titleScore;
  return authorScore * 0.9;
}

function similarityScore(left = '', right = '') {
  const a = normalizeSimilarityText(left);
  const b = normalizeSimilarityText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    const coverage = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    return Math.min(0.98, 0.55 + coverage * 0.45);
  }

  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);
  if (!aBigrams.length || !bBigrams.length) return 0;
  const bCounts = new Map();
  for (const gram of bBigrams) bCounts.set(gram, (bCounts.get(gram) || 0) + 1);
  let overlap = 0;
  for (const gram of aBigrams) {
    const count = bCounts.get(gram) || 0;
    if (!count) continue;
    overlap += 1;
    if (count === 1) {
      bCounts.delete(gram);
    } else {
      bCounts.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (aBigrams.length + bBigrams.length);
}

function normalizeSimilarityText(value = '') {
  return normalizeBookIdentityValue(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(value = '') {
  const text = ` ${value} `;
  const grams = [];
  for (let index = 0; index < text.length - 1; index += 1) grams.push(text.slice(index, index + 2));
  return grams;
}

function getReadingContextActiveMatchMinScore() {
  return readBoundedNumber(process.env.READWISE_READING_CONTEXT_ACTIVE_MATCH_MIN_SCORE, 0.78, 0.5, 1);
}

function getReadingContextHistoryMatchMinScore() {
  return readBoundedNumber(process.env.READWISE_READING_CONTEXT_HISTORY_MATCH_MIN_SCORE, 0.82, 0.5, 1);
}

function getReadingContextHistoryMatchMargin() {
  return readBoundedNumber(process.env.READWISE_READING_CONTEXT_HISTORY_MATCH_MARGIN, 0.08, 0, 1);
}

function readBoundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function firstKnownPage(draft = {}) {
  const extractedPage = (Array.isArray(draft.extractedHighlights) ? draft.extractedHighlights : [])
    .map((highlight) => normalizeWorkerText(highlight?.page || ''))
    .find(Boolean);
  return extractedPage || normalizeWorkerText(draft.highlight?.page || draft.ocr?.page || '');
}

function isCompleteBookIdentity(identity = {}) {
  const normalized = normalizeWorkerBookIdentity(identity);
  return Boolean(normalized.title && normalized.author);
}

function normalizeWorkerBookIdentity(identity = {}) {
  const value = identity && typeof identity === 'object' ? identity : {};
  return {
    ...value,
    title: normalizeBookIdentityValue(value.title),
    author: normalizeBookIdentityValue(value.author),
    status: normalizeBookIdentityValue(value.status),
    source: normalizeBookIdentityValue(value.source)
  };
}

function normalizeBookIdentityValue(value = '') {
  return normalizeWorkerText(value)
    .replace(/^unknown\b.*$/i, '')
    .replace(/^null$/i, '')
    .trim();
}

function normalizeWorkerText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isProcessableVideoDraft(entry, { draftId, includeStored }) {
  if (!entry?.id || !entry?.draft) return false;
  if (draftId && entry.id !== draftId) return false;
  if (!isProcessableVideoSourceKind(entry.draft.sourceKind)) return false;

  const mode = entry.draft.processing?.mode || 'stored_only';
  if (mode === 'queued') return true;
  return includeStored && ['stored_only', 'failed'].includes(mode);
}

function isProcessableVideoSourceKind(sourceKind = '') {
  return ['book_video', 'alerio_video'].includes(sourceKind);
}

function resolveStoredMediaPath(draft, mediaDir) {
  const filename = draft.storage?.filename || filenameFromUrl(draft.videoUrl);
  if (!filename || filename.includes('/') || filename.includes('\\')) return '';

  const root = path.resolve(mediaDir);
  const filePath = path.resolve(root, filename);
  if (filePath !== root && filePath.startsWith(`${root}${path.sep}`)) return filePath;
  return '';
}

function filenameFromUrl(url = '') {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(path.basename(parsed.pathname));
  } catch (_error) {
    return '';
  }
}

function normalizeReason(error) {
  return String(error?.message || error || 'worker_failed')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_.:-]/g, '_')
    .slice(0, 160);
}

function getWorkerLimit() {
  const parsed = Number(process.env.READWISE_VIDEO_WORKER_LIMIT || 1);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(10, Math.floor(parsed)) : 1;
}

function getWorkerIntervalMs() {
  const parsed = Number(process.env.READWISE_VIDEO_WORKER_INTERVAL_MS || 60000);
  return Number.isFinite(parsed) && parsed >= 5000 ? Math.floor(parsed) : 60000;
}

function parseArgs(argv = []) {
  const args = { loop: false, once: false, id: '', includeStored: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--loop') args.loop = true;
    if (arg === '--once') args.once = true;
    if (arg === '--include-stored') args.includeStored = true;
    if (arg === '--id') {
      args.id = argv[index + 1] || '';
      index += 1;
    }
  }
  return args;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const runOnce = async () => {
    const result = await processQueuedVideoDrafts({
      draftId: args.id,
      includeStored: args.includeStored || Boolean(args.id)
    });
    console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
  };

  if (args.loop) {
    while (true) {
      await runOnce();
      await sleep(getWorkerIntervalMs());
    }
  } else {
    await runOnce();
  }
}
