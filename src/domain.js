export function parseOcrText(rawText = '') {
  const lines = String(rawText).split(/\r?\n/);
  const meta = {};
  const body = [];

  for (const line of lines) {
    const match = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (match) {
      meta[match[1].toLowerCase()] = match[2].trim();
    } else {
      body.push(line);
    }
  }

  return {
    title: meta.title || 'Unknown Book',
    author: meta.author || 'Unknown Author',
    page: Number(meta.page || 0) || null,
    text: body.join('\n').trim()
  };
}

export function extractHighlight(ocr) {
  const lines = ocr.text.split(/\r?\n/);
  const highlightLine = lines.find((line) => line.startsWith('[HIGHLIGHT]'));
  const noteLine = lines.find((line) => line.startsWith('[NOTE]'));
  const fallback = ocr.text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .find(Boolean);

  return {
    title: ocr.title,
    author: ocr.author,
    page: ocr.page,
    text: (highlightLine || fallback || '').replace('[HIGHLIGHT]', '').trim(),
    note: (noteLine || '').replace('[NOTE]', '').trim()
  };
}

export function buildReadwisePayload(highlight) {
  return {
    endpoint: 'POST https://readwise.io/api/v2/highlights/',
    body: {
      highlights: [
        {
          text: highlight.text,
          title: highlight.title,
          author: highlight.author,
          source_type: 'mentra_live',
          category: 'books',
          location_type: 'page',
          location: highlight.page,
          note: highlight.note
        }
      ]
    }
  };
}

export function buildApprovalDraft({
  ocrText = '',
  imageUrl = '',
  videoUrl = '',
  audioUrl = '',
  frameUrls = [],
  extractedHighlights = [],
  sourceKind = 'book_page',
  target = 'readwise',
  approvalPrompt = 'Approve this extracted highlight for Readwise?',
  requestId = '',
  testRunId = '',
  storage = null,
  audioStorage = null,
  processing = null
} = {}) {
  const ocr = parseOcrText(ocrText);
  const highlight = extractHighlight(ocr);
  const metadata = buildTraceMetadata({ requestId, testRunId });
  const storageMetadata = buildStorageMetadata(storage);
  const audioStorageMetadata = buildStorageMetadata(audioStorage);
  const processingMetadata = buildProcessingMetadata(processing);
  const structuredHighlights = normalizeExtractedHighlights(extractedHighlights);

  return {
    status: 'pending_approval',
    target,
    sourceKind,
    imageUrl: imageUrl || null,
    videoUrl: videoUrl || null,
    audioUrl: audioUrl || null,
    frameUrls: Array.isArray(frameUrls) ? frameUrls.filter(Boolean) : [],
    ...(structuredHighlights.length ? { extractedHighlights: structuredHighlights } : {}),
    ...(metadata ? { metadata } : {}),
    ...(storageMetadata ? { storage: storageMetadata } : {}),
    ...(audioStorageMetadata ? { audioStorage: audioStorageMetadata } : {}),
    ...(processingMetadata ? { processing: processingMetadata } : {}),
    approvalPrompt,
    ocr,
    highlight,
    readwisePayload: buildReadwisePayload(highlight)
  };
}

export function buildTraceMetadata({ requestId = '', testRunId = '' } = {}) {
  const safeRequestId = normalizeTraceValue(requestId);
  const safeTestRunId = normalizeTraceValue(testRunId);
  if (!safeRequestId && !safeTestRunId) return null;
  return {
    ...(safeRequestId ? { requestId: safeRequestId } : {}),
    ...(safeTestRunId ? { testRunId: safeTestRunId } : {})
  };
}

export async function sendReadwiseHighlight({ payload, token, liveWrites = false, fetchImpl = fetch }) {
  if (!liveWrites) {
    return {
      mode: 'dry_run',
      target: 'readwise',
      wouldSend: payload
    };
  }

  if (!token) throw new Error('READWISE_TOKEN is required for live Readwise writes.');

  const response = await fetchImpl('https://readwise.io/api/v2/highlights/', {
    method: 'POST',
    headers: {
      Authorization: `Token ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload.body)
  });

  if (!response.ok) {
    throw new Error(`Readwise write failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

export function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeTraceValue(value = '') {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 160);
}

function buildStorageMetadata(storage) {
  if (!storage || typeof storage !== 'object') return null;
  const filename = normalizeTraceValue(storage.filename);
  const mimeType = String(storage.mimeType || '').trim().slice(0, 120);
  const url = String(storage.url || '').trim().slice(0, 1000);
  const size = Number(storage.size);
  if (!filename && !mimeType && !url && !Number.isFinite(size)) return null;
  return {
    ...(filename ? { filename } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(Number.isFinite(size) && size >= 0 ? { size: Math.floor(size) } : {}),
    ...(url ? { url } : {})
  };
}

function buildProcessingMetadata(processing) {
  if (!processing || typeof processing !== 'object') return null;
  const mode = normalizeTraceValue(processing.mode);
  const reason = normalizeTraceValue(processing.reason);
  const frameCount = Number(processing.frameCount);
  const candidateFrameCount = Number(processing.candidateFrameCount);
  const selectedFrameCount = Number(processing.selectedFrameCount);
  const qualityFrameCount = Number(processing.qualityFrameCount);
  const duplicateFrameCount = Number(processing.duplicateFrameCount ?? processing.dedupedFrameCount);
  const ocrDuplicateFrameCount = Number(processing.ocrDuplicateFrameCount);
  const ocrFrameCount = Number(processing.ocrFrameCount);
  const highlightCount = Number(processing.highlightCount);
  const highlightOcrFrameCount = Number(processing.highlightOcrFrameCount);
  const highlightOcrSource = normalizeTraceValue(processing.highlightOcrSource);
  const bookIdentityStatus = normalizeTraceValue(processing.bookIdentityStatus);
  const bookIdentitySource = normalizeTraceValue(processing.bookIdentitySource);
  const sharpnessScore = Number(processing.sharpnessScore);
  const audioTranscriptSource = normalizeTraceValue(processing.audioTranscriptSource);
  const contextKind = normalizeTraceValue(processing.contextKind);
  if (
    !mode &&
    !reason &&
    !audioTranscriptSource &&
    !contextKind &&
    !highlightOcrSource &&
    !bookIdentityStatus &&
    !bookIdentitySource &&
    !Number.isFinite(frameCount) &&
    !Number.isFinite(candidateFrameCount) &&
    !Number.isFinite(selectedFrameCount) &&
    !Number.isFinite(qualityFrameCount) &&
    !Number.isFinite(duplicateFrameCount) &&
    !Number.isFinite(ocrDuplicateFrameCount) &&
    !Number.isFinite(ocrFrameCount) &&
    !Number.isFinite(highlightCount) &&
    !Number.isFinite(highlightOcrFrameCount) &&
    !Number.isFinite(sharpnessScore)
  ) {
    return null;
  }
  return {
    ...(mode ? { mode } : {}),
    ...(Number.isFinite(frameCount) && frameCount >= 0 ? { frameCount: Math.floor(frameCount) } : {}),
    ...(Number.isFinite(candidateFrameCount) && candidateFrameCount >= 0 ? { candidateFrameCount: Math.floor(candidateFrameCount) } : {}),
    ...(Number.isFinite(selectedFrameCount) && selectedFrameCount >= 0 ? { selectedFrameCount: Math.floor(selectedFrameCount) } : {}),
    ...(Number.isFinite(qualityFrameCount) && qualityFrameCount >= 0 ? { qualityFrameCount: Math.floor(qualityFrameCount) } : {}),
    ...(Number.isFinite(duplicateFrameCount) && duplicateFrameCount >= 0 ? { duplicateFrameCount: Math.floor(duplicateFrameCount) } : {}),
    ...(Number.isFinite(ocrDuplicateFrameCount) && ocrDuplicateFrameCount >= 0 ? { ocrDuplicateFrameCount: Math.floor(ocrDuplicateFrameCount) } : {}),
    ...(Number.isFinite(ocrFrameCount) && ocrFrameCount >= 0 ? { ocrFrameCount: Math.floor(ocrFrameCount) } : {}),
    ...(Number.isFinite(highlightCount) && highlightCount >= 0 ? { highlightCount: Math.floor(highlightCount) } : {}),
    ...(Number.isFinite(highlightOcrFrameCount) && highlightOcrFrameCount >= 0 ? { highlightOcrFrameCount: Math.floor(highlightOcrFrameCount) } : {}),
    ...(Number.isFinite(sharpnessScore) && sharpnessScore >= 0 ? { sharpnessScore: Math.round(sharpnessScore * 1000) / 1000 } : {}),
    ...(audioTranscriptSource ? { audioTranscriptSource } : {}),
    ...(contextKind ? { contextKind } : {}),
    ...(highlightOcrSource ? { highlightOcrSource } : {}),
    ...(bookIdentityStatus ? { bookIdentityStatus } : {}),
    ...(bookIdentitySource ? { bookIdentitySource } : {}),
    ...(reason ? { reason } : {})
  };
}

function normalizeExtractedHighlights(highlights = []) {
  if (!Array.isArray(highlights)) return [];
  return highlights
    .map((highlight) => {
      const text = normalizeText(highlight?.text || '').slice(0, 900);
      if (!text) return null;
      const page = normalizeText(highlight?.page || '').slice(0, 40);
      const frameIndex = Number(highlight?.frameIndex);
      const confidence = highlight?.confidence === null || highlight?.confidence === undefined ? null : Number(highlight.confidence);
      return {
        text,
        ...(page ? { page } : {}),
        ...(Number.isFinite(frameIndex) && frameIndex >= 0 ? { frameIndex: Math.floor(frameIndex) } : {}),
        ...(highlight?.title ? { title: normalizeText(highlight.title).slice(0, 160) } : {}),
        ...(highlight?.author ? { author: normalizeText(highlight.author).slice(0, 160) } : {}),
        ...(highlight?.marker ? { marker: normalizeText(highlight.marker).slice(0, 120) } : {}),
        ...(Number.isFinite(confidence) ? { confidence: Math.max(0, Math.min(1, confidence)) } : {}),
        ...(highlight?.provider ? { provider: normalizeTraceValue(highlight.provider) } : {}),
        ...(highlight?.model ? { model: normalizeTraceValue(highlight.model) } : {})
      };
    })
    .filter(Boolean);
}
