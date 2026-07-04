import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { extractBookTextWithLocalOcr } from './ocr.js';
import { transcribeAudioRemotely } from './transcription.js';

const execFileAsync = promisify(execFile);

export async function processBookVideo({
  videoPath,
  mediaDir = process.env.MEDIA_DIR || path.join(process.cwd(), 'data', 'media'),
  publicBaseUrl = process.env.PUBLIC_URL || '',
  existingTranscript = '',
  frameExtractor = extractVideoFramesWithFfmpeg,
  frameSelector = selectLikelyBookFrames,
  frameScorer = scoreFrameSharpnessWithFfmpeg,
  frameFingerprinter = fingerprintFrameWithFfmpeg,
  frameEnhancer = enhanceFrameForReadwiseWithFfmpeg,
  frameOcrExtractor = extractBookTextWithLocalOcr,
  frameHighlightExtractor = extractMarkedBookHighlights,
  contextInterpreter = interpretVideoReviewContext,
  audioExtractor = extractAudioClipWithFfmpeg,
  audioTranscriber = transcribeAudioRemotely,
  label = 'book_frame'
} = {}) {
  if (!videoPath) throw new Error('video_path_required');
  await fs.access(videoPath);

  const audioTranscript = await transcribeVideoAudio({
    videoPath,
    existingTranscript,
    audioExtractor,
    audioTranscriber
  });
  const transcript = audioTranscript.text || normalizeNoteText(existingTranscript);

  const candidateFrames = (await frameExtractor({
    videoPath,
    mediaDir,
    publicBaseUrl,
    label
  })) || [];
  const minBytes = getVideoMinFrameBytes();
  const minSharpnessScore = getVideoMinSharpnessScore();
  const scoredCandidateFrames = await scoreCandidateFrames(candidateFrames, { frameScorer });
  const fingerprintedCandidateFrames = await fingerprintCandidateFrames(scoredCandidateFrames, {
    frameFingerprinter,
    minBytes,
    minSharpnessScore
  });
  const selectedCandidates = (await frameSelector(fingerprintedCandidateFrames, {
    maxSelected: getVideoSelectedFrameCount(),
    minBytes,
    minSharpnessScore,
    dedupeEnabled: isVideoFrameDedupeEnabled(),
    dedupeDistance: getVideoDedupeHashDistance(),
    dedupeLumaMad: getVideoDedupeLumaMad(),
    dedupeIndexWindow: getVideoDedupeMaxIndexGap()
  })) || [];
  const selectedFrames = await enhanceSelectedFrames(selectedCandidates, {
    mediaDir,
    publicBaseUrl,
    frameEnhancer
  });
  const ocrDedupedFrames = await dedupeSelectedFramesByOcr(selectedFrames, { frameOcrExtractor });
  const highlightExtraction = await extractSelectedFrameHighlights(ocrDedupedFrames.frames, { frameHighlightExtractor });
  const bookIdentity = resolveBookIdentity({
    transcript,
    highlights: highlightExtraction.highlights
  });
  const contextSnippets = mergeOcrContextSnippets(highlightExtraction.ocrSnippets, ocrDedupedFrames.ocrSnippets);
  await removeRejectedSelectedFrames(selectedFrames, ocrDedupedFrames.frames);
  await removeRejectedCandidateFrames(candidateFrames, ocrDedupedFrames.frames);
  const frameUrls = ocrDedupedFrames.frames.map((frame) => frame.url).filter(Boolean);
  const qualityFrameCount = scoredCandidateFrames.filter((frame) => Number.isFinite(getFrameSharpnessScore(frame))).length;
  const sharpnessScore = getBestSharpnessScore(ocrDedupedFrames.frames);
  const contextDecision = await resolveVideoContextDecision({
    transcript,
    ocrSnippets: contextSnippets,
    contextInterpreter
  });
  const reviewNote = buildVideoReviewNote(transcript, ocrDedupedFrames.ocrSnippets, contextDecision, highlightExtraction.highlights);

  return {
    videoPath,
    transcript,
    reviewNote,
    ocrContext: formatOcrSnippets(contextSnippets),
    contextDecision,
    bookIdentity,
    extractedHighlights: highlightExtraction.highlights,
    ocrText: buildProcessedVideoImageOnlyText(reviewNote, highlightExtraction.highlights, bookIdentity),
    candidateFrames: fingerprintedCandidateFrames,
    selectedFrames: ocrDedupedFrames.frames,
    frameUrls,
    processing: {
      frameCount: ocrDedupedFrames.frames.length,
      candidateFrameCount: fingerprintedCandidateFrames.length,
      selectedFrameCount: ocrDedupedFrames.frames.length,
      qualityFrameCount,
      duplicateFrameCount: countNearDuplicateFrames(fingerprintedCandidateFrames, {
        minBytes,
        minSharpnessScore,
        dedupeEnabled: isVideoFrameDedupeEnabled(),
        dedupeDistance: getVideoDedupeHashDistance(),
        dedupeLumaMad: getVideoDedupeLumaMad(),
        dedupeIndexWindow: getVideoDedupeMaxIndexGap()
      }),
      ocrDuplicateFrameCount: ocrDedupedFrames.duplicateCount,
      contextKind: contextDecision.kind,
      ...(highlightExtraction.source !== 'disabled'
        ? {
            highlightCount: highlightExtraction.highlights.length,
            highlightOcrFrameCount: highlightExtraction.frameCount,
            highlightOcrSource: highlightExtraction.source
          }
        : {}),
      sharpnessScore,
      ocrFrameCount: ocrDedupedFrames.ocrFrameCount,
      audioTranscriptSource: audioTranscript.source,
      bookIdentityStatus: bookIdentity.status,
      bookIdentitySource: bookIdentity.source,
      reason: processingReason({ selectedFrameCount: ocrDedupedFrames.frames.length })
    }
  };
}

export async function extractVideoFramesWithFfmpeg({ videoPath, mediaDir, publicBaseUrl, label = 'book_frame', execFileImpl = execFileAsync } = {}) {
  if (!videoPath) return [];
  await fs.mkdir(mediaDir, { recursive: true });

  const safeLabel = String(label || 'book_frame').replace(/[^a-zA-Z0-9_-]/g, '_');
  const prefix = `${safeLabel}_${Date.now()}_${randomUUID()}`;
  const outputPattern = path.join(mediaDir, `${prefix}_%03d.jpg`);
  const durationSeconds = await getVideoDurationSeconds({ videoPath, execFileImpl });
  const explicitCandidateFrameCount = getExplicitVideoCandidateFrameCount();
  const candidateFrameTarget = explicitCandidateFrameCount || getMaxVideoCandidateFrameCount();
  const sampleIntervalSeconds = getVideoCandidateSampleIntervalSeconds(durationSeconds, candidateFrameTarget);
  const candidateFrameCount = getVideoCandidateFrameCount(durationSeconds, sampleIntervalSeconds, explicitCandidateFrameCount);
  const frameLimitArgs = Number.isFinite(candidateFrameCount) && candidateFrameCount > 0
    ? ['-frames:v', String(candidateFrameCount)]
    : [];

  await execFileImpl(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-i',
      videoPath,
      '-an',
      '-threads',
      String(getFfmpegThreads()),
      '-vf',
      buildCandidateFrameFilter(sampleIntervalSeconds),
      '-vsync',
      'vfr',
      ...frameLimitArgs,
      '-q:v',
      '2',
      outputPattern
    ],
    {
      timeout: getVideoFrameTimeoutMs(),
      maxBuffer: 1024 * 1024
    }
  );

  const files = (await fs.readdir(mediaDir)).filter((filename) => filename.startsWith(`${prefix}_`) && filename.endsWith('.jpg')).sort();
  const cappedFiles = Number.isFinite(candidateFrameCount) && candidateFrameCount > 0 ? files.slice(0, candidateFrameCount) : files;
  if (Number.isFinite(candidateFrameCount) && candidateFrameCount > 0) {
    await Promise.all(files.slice(candidateFrameCount).map((filename) => fs.rm(path.join(mediaDir, filename), { force: true })));
  }
  const frames = [];
  for (const [index, filename] of cappedFiles.entries()) {
    const filePath = path.join(mediaDir, filename);
    let size = 0;
    try {
      size = (await fs.stat(filePath)).size;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    frames.push({
      filename,
      filePath,
      index,
      mimeType: 'image/jpeg',
      size,
      url: publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/media/${encodeURIComponent(filename)}` : null
    });
  }
  return frames;
}

export function selectLikelyBookFrames(
  frames = [],
  {
    maxSelected = getVideoSelectedFrameCount(),
    minBytes = getVideoMinFrameBytes(),
    minSharpnessScore = getVideoMinSharpnessScore(),
    dedupeEnabled = isVideoFrameDedupeEnabled(),
    dedupeDistance = getVideoDedupeHashDistance(),
    dedupeLumaMad = getVideoDedupeLumaMad(),
    dedupeIndexWindow = getVideoDedupeMaxIndexGap()
  } = {}
) {
  const eligible = frames
    .map((frame, index) => ({
      ...frame,
      index: Number.isFinite(Number(frame.index)) ? Number(frame.index) : index
    }))
    .filter((frame) => isSelectableFrame(frame, { minBytes, minSharpnessScore }))
    .sort((a, b) => a.index - b.index);

  const selected = eligible.some((frame) => Number.isFinite(getFrameSharpnessScore(frame)))
    ? selectChronologicalQualitySpread(eligible, maxSelected, { dedupeEnabled, dedupeDistance, dedupeLumaMad, dedupeIndexWindow })
    : selectChronologicalSpread(eligible, maxSelected, { dedupeEnabled, dedupeDistance, dedupeLumaMad, dedupeIndexWindow });
  return selected.map((frame) => ({
    ...frame,
    selectedAs: 'sharp_book_page_candidate'
  }));
}

export async function scoreFrameSharpnessWithFfmpeg({ frame = {}, filePath = frame.filePath, execFileImpl = execFileAsync } = {}) {
  if (!filePath) return { sharpnessScore: null, provider: 'missing_file' };

  const { stdout } = await execFileImpl(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-i',
      filePath,
      '-vf',
      `${getVideoQualityRoiFilter()},edgedetect=low=0.05:high=0.15,signalstats,metadata=print:file=-`,
      '-frames:v',
      '1',
      '-f',
      'null',
      '-'
    ],
    {
      timeout: getVideoQualityTimeoutMs(),
      maxBuffer: 1024 * 1024
    }
  );

  const sharpnessScore = Number(String(stdout || '').match(/lavfi\.signalstats\.YAVG=([0-9.]+)/)?.[1]);
  return {
    provider: 'ffmpeg_edge_signalstats',
    sharpnessScore: Number.isFinite(sharpnessScore) ? sharpnessScore : null
  };
}

export async function fingerprintFrameWithFfmpeg({ frame = {}, filePath = frame.filePath, execFileImpl = execFileAsync } = {}) {
  if (!filePath) return { provider: 'missing_file', fingerprint: null };

  const size = getVideoFingerprintSize();
  const width = size + 1;
  const height = size;
  const { stdout } = await execFileImpl(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-i',
      filePath,
      '-threads',
      String(getFfmpegThreads()),
      '-vf',
      `${getVideoQualityRoiFilter()},scale=${width}:${height}:flags=bilinear,format=gray`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    {
      encoding: 'buffer',
      timeout: getVideoFingerprintTimeoutMs(),
      maxBuffer: width * height + 4096
    }
  );

  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '', 'binary');
  const fingerprint = buildDifferenceFingerprint(buffer, width, height);
  return {
    provider: 'ffmpeg_difference_hash',
    fingerprint: fingerprint.hash,
    lumaVector: fingerprint.lumaVector,
    lumaMean: fingerprint.lumaMean,
    lumaStdDev: fingerprint.lumaStdDev,
    brightRatio: fingerprint.brightRatio,
    darkRatio: fingerprint.darkRatio,
    fingerprintSize: size
  };
}

export async function enhanceFrameForReadwiseWithFfmpeg({
  frame = {},
  mediaDir = path.dirname(frame.filePath || ''),
  publicBaseUrl = '',
  execFileImpl = execFileAsync
} = {}) {
  if (!isVideoReviewImageEnhancementEnabled() || !frame.filePath) return frame;

  const inputPath = frame.filePath;
  const outputDir = mediaDir || path.dirname(inputPath);
  await fs.mkdir(outputDir, { recursive: true });

  const baseName = path.basename(frame.filename || inputPath, path.extname(frame.filename || inputPath)).replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${baseName}_review.jpg`;
  const filePath = path.join(outputDir, filename);
  const scale = getVideoReviewImageScale();
  const maxLongEdge = getVideoReviewImageMaxLongEdge();
  const scaleFilter = scale > 1
    ? `scale=w='if(gte(iw,ih),min(iw*${scale},${maxLongEdge}),-2)':h='if(gte(iw,ih),-2,min(ih*${scale},${maxLongEdge}))':flags=lanczos+accurate_rnd`
    : 'scale=w=iw:h=ih:flags=lanczos';
  const filters = [
    getVideoReviewImageCropFilter(),
    scaleFilter,
    'eq=contrast=1.28:brightness=0.02:saturation=0.45',
    'unsharp=7:7:1.1:3:3:0.35',
    'format=yuvj420p'
  ].filter(Boolean).join(',');

  await execFileImpl(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-i',
      inputPath,
      '-vf',
      filters,
      '-frames:v',
      '1',
      '-q:v',
      '1',
      filePath
    ],
    {
      timeout: getVideoEnhanceTimeoutMs(),
      maxBuffer: 1024 * 1024
    }
  );

  const size = (await fs.stat(filePath)).size;
  return {
    ...frame,
    filename,
    filePath,
    mimeType: 'image/jpeg',
    size,
    url: publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/media/${encodeURIComponent(filename)}` : frame.url || null,
    sourceFrame: frame.filename,
    reviewImageScale: scale
  };
}

export async function extractAudioClipWithFfmpeg({ videoPath } = {}) {
  if (!videoPath) return null;
  const outputPath = path.join(path.dirname(videoPath), `book_audio_${Date.now()}_${randomUUID()}.wav`);
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        '-i',
        videoPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-t',
        String(getVideoAudioMaxSeconds()),
        '-f',
        'wav',
        outputPath
      ],
      {
        timeout: getVideoAudioExtractTimeoutMs(),
        maxBuffer: 1024 * 1024
      }
    );
    const audioBuffer = await fs.readFile(outputPath);
    return {
      audioBuffer,
      mimeType: 'audio/wav',
      filename: path.basename(outputPath)
    };
  } finally {
    await fs.rm(outputPath, { force: true });
  }
}

async function scoreCandidateFrames(frames = [], { frameScorer } = {}) {
  if (!isVideoQualityScoringEnabled() || !frameScorer) return frames;
  const scored = [];
  for (const frame of frames) {
    try {
      const quality = normalizeFrameQuality(await frameScorer({ frame, filePath: frame.filePath }));
      scored.push({ ...frame, quality });
    } catch (error) {
      scored.push({ ...frame, quality: { provider: 'quality_score_failed', reason: normalizeReason(error), sharpnessScore: null } });
    }
  }
  return scored;
}

async function fingerprintCandidateFrames(
  frames = [],
  {
    frameFingerprinter,
    minBytes,
    minSharpnessScore
  } = {}
) {
  if (!isVideoFrameDedupeEnabled() || !frameFingerprinter) return frames;

  const fingerprinted = [];
  for (const frame of frames) {
    if (!isSelectableFrame(frame, { minBytes, minSharpnessScore })) {
      fingerprinted.push(frame);
      continue;
    }

    try {
      const fingerprint = normalizeFrameFingerprint(await frameFingerprinter({ frame, filePath: frame.filePath }));
      fingerprinted.push({ ...frame, fingerprint });
    } catch (error) {
      fingerprinted.push({ ...frame, fingerprint: { provider: 'fingerprint_failed', reason: normalizeReason(error), hash: null } });
    }
  }
  return fingerprinted;
}

async function enhanceSelectedFrames(frames = [], { mediaDir, publicBaseUrl, frameEnhancer } = {}) {
  if (!frameEnhancer) return frames;
  const enhanced = [];
  for (const frame of frames) {
    try {
      enhanced.push(await frameEnhancer({ frame, mediaDir, publicBaseUrl }));
    } catch (error) {
      enhanced.push({ ...frame, reviewImageEnhanceError: normalizeReason(error) });
    }
  }
  return enhanced;
}

async function dedupeSelectedFramesByOcr(frames = [], { frameOcrExtractor } = {}) {
  if (!isVideoOcrDedupeEnabled() || !frameOcrExtractor || frames.length < 2) {
    return { frames, duplicateCount: 0, ocrFrameCount: 0 };
  }

  const selected = [];
  let duplicateCount = 0;
  let ocrFrameCount = 0;
  const ocrSnippets = [];
  const maxFrames = getVideoOcrDedupeMaxFrames();

  for (const frame of frames) {
    if (Number.isFinite(maxFrames) && maxFrames > 0 && ocrFrameCount >= maxFrames) {
      selected.push(frame);
      continue;
    }

    const ocr = await readFrameOcrFingerprint(frame, { frameOcrExtractor });
    ocrFrameCount += ocr.attempted ? 1 : 0;
    const annotatedFrame = {
      ...frame,
      ocrDedupe: {
        provider: ocr.provider,
        wordCount: ocr.words.length,
        reason: ocr.reason || ''
      }
    };

    const duplicate = ocr.words.length >= getVideoOcrDedupeMinWords()
      ? selected.find((candidate) => isDuplicateOcrText(ocr.words, candidate.ocrDedupe?.words || []))
      : null;

    if (duplicate) {
      duplicateCount += 1;
      continue;
    }

    if (ocr.text && ocrSnippets.length < getVideoOcrContextMaxSnippets()) {
      ocrSnippets.push({
        frameIndex: frame.index,
        text: ocr.text
      });
    }

    selected.push({
      ...annotatedFrame,
      ocrDedupe: {
        ...annotatedFrame.ocrDedupe,
        words: ocr.words
      }
    });
  }

  return {
    frames: selected.map((frame) => ({
      ...frame,
      ocrDedupe: frame.ocrDedupe
        ? {
            provider: frame.ocrDedupe.provider,
            wordCount: frame.ocrDedupe.wordCount,
            reason: frame.ocrDedupe.reason
          }
        : undefined
    })),
    duplicateCount,
    ocrFrameCount,
    ocrSnippets
  };
}

async function extractSelectedFrameHighlights(frames = [], { frameHighlightExtractor } = {}) {
  if (!isVideoHighlightOcrEnabled() || !frameHighlightExtractor || !frames.length) {
    return { highlights: [], ocrSnippets: [], frameCount: 0, source: 'disabled' };
  }

  const maxFrames = getVideoHighlightOcrMaxFrames();
  const maxHighlights = getVideoHighlightOcrMaxHighlights();
  const highlights = [];
  let frameCount = 0;
  let source = '';

  for (const frame of frames) {
    if (Number.isFinite(maxFrames) && maxFrames > 0 && frameCount >= maxFrames) break;
    const result = await readFrameHighlights(frame, { frameHighlightExtractor });
    frameCount += result.attempted ? 1 : 0;
    if (!source && result.provider) source = result.provider;

    for (const highlight of result.highlights) {
      if (highlights.length >= maxHighlights) break;
      addExtractedHighlight(highlights, highlight);
    }

    if (highlights.length >= maxHighlights) break;
  }

  return {
    highlights,
    ocrSnippets: highlights.map((highlight) => ({
      frameIndex: highlight.frameIndex,
      page: highlight.page,
      text: highlight.text
    })),
    frameCount,
    source: source || (frameCount ? 'empty' : 'disabled')
  };
}

async function readFrameHighlights(frame = {}, { frameHighlightExtractor } = {}) {
  if (!frame.filePath) return { attempted: false, provider: 'missing_file', highlights: [], reason: 'missing_file' };
  try {
    const result = await frameHighlightExtractor({
      frame,
      filePath: frame.filePath,
      timeoutMs: getVideoHighlightOcrTimeoutMs()
    });
    return {
      attempted: true,
      provider: result?.provider || 'highlight_ocr',
      highlights: normalizeFrameHighlightExtractionResult(result, frame),
      reason: result?.skipped || ''
    };
  } catch (error) {
    return {
      attempted: true,
      provider: 'highlight_ocr_failed',
      highlights: [],
      reason: normalizeReason(error)
    };
  }
}

export async function extractMarkedBookHighlights({
  provider = process.env.READWISE_VIDEO_HIGHLIGHT_OCR_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'openclaw'),
  ...options
} = {}) {
  if (provider === 'off' || provider === 'disabled') {
    return { provider, highlights: [], skipped: 'disabled' };
  }
  if (provider === 'openrouter') {
    return extractMarkedBookHighlightsWithOpenRouter(options);
  }
  if (provider === 'openclaw') {
    return extractMarkedBookHighlightsWithOpenClaw(options);
  }
  return extractMarkedBookHighlightsWithOpenAI(options);
}

export async function extractMarkedBookHighlightsWithOpenAI({
  filePath,
  model = process.env.READWISE_VIDEO_HIGHLIGHT_OCR_MODEL || process.env.OPENAI_VISION_MODEL || 'gpt-5.5',
  apiKey = process.env.OPENAI_API_KEY,
  endpoint = process.env.OPENAI_CHAT_COMPLETIONS_URL || 'https://api.openai.com/v1/chat/completions',
  provider = 'openai',
  extraHeaders = {},
  responseFormat = { type: 'json_object' },
  fallbackModels = null,
  timeoutMs = getVideoHighlightOcrTimeoutMs(),
  fetchImpl = fetch
} = {}) {
  if (!filePath) throw new Error('filePath_required');
  if (!apiKey) return { provider, model, highlights: [], skipped: `missing_${provider}_api_key` };

  const imageBuffer = await fs.readFile(filePath);
  const imageUrl = `data:${mimeTypeForImagePath(filePath)};base64,${imageBuffer.toString('base64')}`;
  const models = Array.isArray(fallbackModels) && fallbackModels.length
    ? Array.from(new Set([model, ...fallbackModels].filter(Boolean)))
    : getOpenAiHighlightOcrModels(model);
  const details = getOpenAiHighlightOcrImageDetails();
  let lastError = null;

  for (const modelName of models) {
    for (const detail of details) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            ...extraHeaders
          },
          body: JSON.stringify({
            model: modelName,
            ...(responseFormat ? { response_format: responseFormat } : {}),
            messages: [
              {
                role: 'system',
                content: buildMarkedHighlightSystemPrompt()
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: buildMarkedHighlightUserPrompt()
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url: imageUrl,
                      detail
                    }
                  }
                ]
              }
            ]
          }),
          signal: controller.signal
        });
      } catch (error) {
        lastError = error;
        continue;
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        lastError = new Error(`openai_highlight_ocr_failed:${response.status}:${modelName}:${detail}`);
        continue;
      }

      const payload = await response.json();
      return {
        provider,
        model: modelName,
        detail,
        ...parseHighlightExtractionPayload(payload?.choices?.[0]?.message?.content || '')
      };
    }
  }

  throw lastError || new Error('openai_highlight_ocr_failed');
}

export async function extractMarkedBookHighlightsWithOpenRouter({
  filePath,
  model = process.env.READWISE_VIDEO_HIGHLIGHT_OCR_MODEL || process.env.OPENROUTER_VISION_MODEL || 'google/gemini-2.5-pro',
  apiKey = process.env.OPENROUTER_API_KEY,
  endpoint = process.env.OPENROUTER_CHAT_COMPLETIONS_URL || 'https://openrouter.ai/api/v1/chat/completions',
  timeoutMs = getVideoHighlightOcrTimeoutMs(),
  fetchImpl = fetch
} = {}) {
  return extractMarkedBookHighlightsWithOpenAI({
    filePath,
    model,
    apiKey,
    endpoint,
    provider: 'openrouter',
    extraHeaders: getOpenRouterHeaders(),
    responseFormat: null,
    fallbackModels: getOpenRouterHighlightOcrModels(model),
    timeoutMs,
    fetchImpl
  });
}

export async function extractMarkedBookHighlightsWithOpenClaw({
  filePath,
  model = process.env.READWISE_VIDEO_HIGHLIGHT_OCR_MODEL || 'openrouter/auto',
  timeoutMs = getVideoHighlightOcrTimeoutMs(),
  execFileImpl = execFileAsync
} = {}) {
  if (!filePath) throw new Error('filePath_required');
  const prompt = `${buildMarkedHighlightSystemPrompt()}\n\n${buildMarkedHighlightUserPrompt()}`;
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

  const { stdout } = await execFileImpl('openclaw', args, {
    timeout: timeoutMs + 5000,
    maxBuffer: 2 * 1024 * 1024
  });
  return {
    provider: 'openclaw',
    model,
    ...parseHighlightExtractionPayload(extractOpenClawText(stdout))
  };
}

async function readFrameOcrFingerprint(frame = {}, { frameOcrExtractor } = {}) {
  if (!frame.filePath) return { attempted: false, provider: 'missing_file', words: [], reason: 'missing_file' };
  try {
    const result = await frameOcrExtractor({
      filePath: frame.filePath,
      timeoutMs: getVideoOcrDedupeTimeoutMs(),
      lang: getVideoOcrDedupeLang()
    });
    const rawText = String(result?.text || '');
    const cleanedText = normalizeOcrContextText(rawText);
    const words = buildOcrWordFingerprint(cleanedText);
    return {
      attempted: true,
      provider: result?.provider || 'ocr',
      words,
      text: isUsefulOcrContextSnippet(rawText, cleanedText, words) ? cleanedText : '',
      reason: ''
    };
  } catch (error) {
    return {
      attempted: true,
      provider: 'ocr_failed',
      words: [],
      text: '',
      reason: normalizeReason(error)
    };
  }
}

function parseHighlightExtractionPayload(content = '') {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  if (!text) return { highlights: [] };
  const jsonText = extractJsonObjectText(text);
  try {
    return JSON.parse(jsonText || text);
  } catch (_error) {
    if (isNoMarkedTextResponse(text)) return { hasMarkedText: false, highlights: [] };
    return {
      hasMarkedText: true,
      highlights: [
        {
          text
        }
      ]
    };
  }
}

function isNoMarkedTextResponse(text = '') {
  const value = String(text || '').toLowerCase();
  return /\b(no|not|unable to find|could not find|did not find)\b[\s\S]{0,120}\b(reader[-\s]?marked|marked passage|marked text|pen[-\s]?marked|highlighted passage|book page|book)\b/.test(value);
}

function extractJsonObjectText(text = '') {
  const fenced = String(text || '').match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const value = String(text || '');
  const start = value.indexOf('{');
  if (start < 0) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return value.slice(start, index + 1).trim();
  }

  return '';
}

function buildMarkedHighlightSystemPrompt() {
  return [
    'Extract only reader-marked book passages from an image.',
    'Reader marks can be pen highlights, underlines, circles, brackets, or handwritten emphasis.',
    'Do not treat printed headings, bold text, sample boxes, gray callouts, or text that says "highlight" as reader marks unless there is visible external ink or highlighter overlay distinct from the book typography.',
    'Ignore the book design itself, including printed gray shading or examples about highlights; if you cannot identify reader-added ink, return hasMarkedText false.',
    'Return one complete quote for each reader-added mark. If one mark spans wrapped lines or adjacent lines, merge it into one complete passage.',
    'If a reader mark covers only a phrase inside a sentence, return the full sentence containing that marked phrase.',
    'Do not return OCR fragments, partial words, dangling clause endings, or duplicate variants of the same marked passage.',
    'If two marked areas touch or clearly belong to the same continuous passage, return one combined quote.',
    'Prefer the exact printed book words over paraphrase. Preserve casing and punctuation when readable.',
    'Return compact JSON with keys: title, author, page, hasMarkedText, highlights.',
    'highlights must be an array of objects with keys: text, page, marker, confidence.',
    'Only include text that is visibly marked. Do not invent missing words or page numbers.'
  ].join(' ');
}

function buildMarkedHighlightUserPrompt() {
  return 'Find the reader-marked passage text and visible page number in this enhanced book page frame. Use OCR-quality transcription. Join wrapped marked lines into complete quotes. If there is no pen-marked or highlighted passage, return {"hasMarkedText":false,"highlights":[]}.';
}

function extractOpenClawText(stdout = '') {
  const text = String(stdout || '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    return findOpenClawText(parsed);
  } catch (_error) {
    return text;
  }
}

function findOpenClawText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findOpenClawText(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    for (const key of ['text', 'content', 'message', 'result', 'output', 'outputs']) {
      const found = findOpenClawText(value[key]);
      if (found) return found;
    }
  }
  return '';
}

function normalizeFrameHighlightExtractionResult(result = {}, frame = {}) {
  const payload = typeof result?.text === 'string' ? parseHighlightExtractionPayload(result.text) : result || {};
  if (shouldRequireMarkedHighlights() && payload.hasMarkedText === false) return [];

  const title = normalizeOptionalText(payload.title);
  const author = normalizeOptionalText(payload.author);
  const page = normalizePageLabel(payload.page);
  const rawHighlights = Array.isArray(payload.highlights)
    ? payload.highlights
    : Array.isArray(payload.markedHighlights)
      ? payload.markedHighlights
      : Array.isArray(payload.penHighlights)
        ? payload.penHighlights
        : [];
  const fallbackHighlightText = normalizeHighlightText(payload.highlightText || payload.highlight || '');
  const candidates = rawHighlights.length ? rawHighlights : fallbackHighlightText ? [{ text: fallbackHighlightText }] : [];

  return candidates
    .map((item) => {
      const text = normalizeHighlightText(item?.text || item?.highlightText || item?.quote || '');
      if (!text || /^ocr pending\b/i.test(text)) return null;
      const itemPage = normalizePageLabel(item?.page) || page;
      const marker = normalizeOptionalText(item?.marker || item?.mark || (payload.hasMarkedText ? 'marked' : ''));
      if (shouldRequireMarkedHighlights() && !isSpecificReaderMarker(marker)) return null;
      const itemTitle = normalizeOptionalText(item?.title) || title;
      const itemAuthor = normalizeOptionalText(item?.author) || author;
      return {
        frameIndex: Number.isFinite(Number(frame.index)) ? Number(frame.index) : null,
        page: itemPage || null,
        text,
        ...(itemTitle ? { title: itemTitle } : {}),
        ...(itemAuthor ? { author: itemAuthor } : {}),
        marker,
        confidence: normalizeConfidence(item?.confidence),
        provider: normalizeReason(result?.provider || 'highlight_ocr'),
        ...(result?.model ? { model: normalizeReason(result.model) } : {})
      };
    })
    .filter(Boolean);
}

function isSpecificReaderMarker(marker = '') {
  const text = String(marker || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (!text) return false;
  if (/\b(printed|heading|bold|callout|sample|box|gray|grey|typography|design)\b/.test(text)) return false;
  if (/^(highlight|highlighted|marked|emphasis)$/i.test(text.trim())) return false;
  if (/^(ink|pen|marker|reader mark)$/i.test(text.trim())) return false;
  return /\b(pen|ink|underline|underlined|circle|circled|bracket|bracketed|handwritten|handwriting|note|scribble|highlighter|yellow|pink|blue|green|orange|purple|marker)\b/.test(text);
}

function normalizeOptionalText(value = '') {
  const text = normalizeNoteText(value);
  if (!text || /^unknown\b/i.test(text) || /^null$/i.test(text)) return '';
  return text;
}

function normalizeHighlightText(value = '') {
  return normalizeNoteText(value).replace(/^\[(?:highlight|note)\]\s*/i, '').slice(0, 700);
}

function normalizePageLabel(value = '') {
  const text = String(value || '').trim();
  if (!text || /^unknown\b/i.test(text) || /^null$/i.test(text)) return '';
  return text.replace(/^p(?:age)?\.?\s*/i, '').slice(0, 40);
}

function normalizeConfidence(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return null;
  return Math.max(0, Math.min(1, confidence));
}

function addExtractedHighlight(highlights = [], highlight = {}) {
  const normalized = normalizeExtractedHighlightCandidate(highlight);
  if (!normalized || isLikelyFragmentHighlight(normalized.text)) return false;

  const duplicateIndex = findDuplicateExtractedHighlightIndex(highlights, normalized);
  if (duplicateIndex >= 0) {
    if (isBetterExtractedHighlight(normalized, highlights[duplicateIndex])) {
      highlights[duplicateIndex] = mergeExtractedHighlight(highlights[duplicateIndex], normalized);
    }
    return false;
  }

  highlights.push(normalized);
  return true;
}

function normalizeExtractedHighlightCandidate(highlight = {}) {
  const text = normalizeHighlightText(highlight.text);
  if (!text) return null;
  return {
    ...highlight,
    text,
    page: normalizePageLabel(highlight.page) || null,
    marker: normalizeOptionalText(highlight.marker || ''),
    confidence: normalizeConfidence(highlight.confidence)
  };
}

function findDuplicateExtractedHighlightIndex(existing = [], highlight = {}) {
  const text = normalizeHighlightText(highlight.text);
  const page = normalizePageLabel(highlight.page).toLowerCase();
  if (!text) return 0;

  return existing.findIndex((candidate) => {
    const candidateText = normalizeHighlightText(candidate.text);
    const candidatePage = normalizePageLabel(candidate.page).toLowerCase();
    if (page && candidatePage && page !== candidatePage) return false;
    return areSimilarHighlightTexts(candidateText, text);
  });
}

function isDuplicateExtractedHighlight(existing = [], highlight = {}) {
  const normalized = normalizeExtractedHighlightCandidate(highlight);
  if (!normalized || isLikelyFragmentHighlight(normalized.text)) return true;
  return findDuplicateExtractedHighlightIndex(existing, normalized) >= 0;
}

function areSimilarHighlightTexts(a = '', b = '') {
  const left = normalizeHighlightForComparison(a);
  const right = normalizeHighlightForComparison(b);
  if (!left || !right) return !left && !right;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  if (shorter.length >= 24 && longer.includes(shorter)) return true;

  const leftWords = highlightComparisonWords(left);
  const rightWords = highlightComparisonWords(right);
  if (leftWords.length < 4 || rightWords.length < 4) return false;

  const leftSet = new Set(leftWords);
  const rightSet = new Set(rightWords);
  const intersection = [...leftSet].filter((word) => rightSet.has(word)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  const containment = intersection / Math.min(leftSet.size, rightSet.size);
  const jaccard = intersection / union;
  return containment >= 0.76 || jaccard >= 0.68;
}

function isLikelyFragmentHighlight(text = '') {
  const normalized = normalizeHighlightText(text);
  if (!normalized) return true;
  const words = highlightComparisonWords(normalized);
  if (normalized.length < 28 && words.length < 6) return true;
  if (/^[,.;:)\]}]/.test(normalized)) return true;
  if (/^[-\u2010-\u2015]/.test(normalized)) return true;
  if (/^(?:to-day|day basis|basis,?\s+i\s+wake)\b/i.test(normalized)) return true;
  if (/^(?:n['’]t|on['’]t)\b/i.test(normalized)) return true;
  if (hasUnbalancedQuote(normalized)) return true;
  if (/\b(?:hos|thi|th|tha|usefu|useful thi|somethin|importan)$/i.test(normalized)) return true;
  if (/\b(?:hos|thing et|th get)\b/i.test(normalized)) return true;
  return false;
}

function hasUnbalancedQuote(text = '') {
  const normalized = String(text || '').replace(/[“”]/g, '"');
  const quoteCount = (normalized.match(/"/g) || []).length;
  return quoteCount % 2 === 1;
}

function mergeExtractedHighlight(existing = {}, replacement = {}) {
  return {
    ...existing,
    ...replacement,
    marker: replacement.marker || existing.marker || '',
    confidence: Math.max(Number(existing.confidence || 0), Number(replacement.confidence || 0)) || null,
    title: replacement.title || existing.title,
    author: replacement.author || existing.author
  };
}

function isBetterExtractedHighlight(candidate = {}, existing = {}) {
  return scoreExtractedHighlight(candidate) > scoreExtractedHighlight(existing);
}

function scoreExtractedHighlight(highlight = {}) {
  const text = normalizeHighlightText(highlight.text);
  const words = highlightComparisonWords(text);
  let score = 0;
  score += Math.min(text.length / 180, 1) * 4;
  score += Math.min(words.length / 24, 1) * 2;
  if (/[.!?]["'”’)]?$/.test(text)) score += 0.6;
  if (/^[A-Z0-9"'“‘]/.test(text)) score += 0.3;
  if (normalizePageLabel(highlight.page)) score += 0.2;
  if (isSpecificReaderMarker(highlight.marker)) score += 0.3;
  if (Number.isFinite(Number(highlight.confidence))) score += Number(highlight.confidence);
  if (isLikelyFragmentHighlight(text)) score -= 8;
  return score;
}

function normalizeHighlightForComparison(text = '') {
  return normalizeHighlightText(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function highlightComparisonWords(text = '') {
  return normalizeHighlightForComparison(text)
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !OCR_DEDUPE_STOP_WORDS.has(word));
}

function getOpenAiHighlightOcrModels(primaryModel = '') {
  const configuredFallbacks = String(process.env.READWISE_VIDEO_HIGHLIGHT_OCR_FALLBACK_MODELS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const models = [
    primaryModel,
    ...configuredFallbacks,
    'gpt-4.1',
    'gpt-4o'
  ].filter(Boolean);
  return Array.from(new Set(models));
}

function getOpenAiHighlightOcrImageDetails() {
  const primary = process.env.READWISE_VIDEO_HIGHLIGHT_OCR_IMAGE_DETAIL || 'high';
  return Array.from(new Set([primary, 'high', 'auto'].filter(Boolean)));
}

function getOpenRouterHighlightOcrModels(primaryModel = '') {
  const configuredFallbacks = String(process.env.READWISE_VIDEO_HIGHLIGHT_OCR_FALLBACK_MODELS || process.env.OPENROUTER_VISION_FALLBACK_MODELS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const models = [
    ...configuredFallbacks,
    'google/gemini-2.5-pro',
    'google/gemini-2.5-flash',
    'anthropic/claude-sonnet-4'
  ].filter((item) => item && item !== primaryModel);
  return Array.from(new Set(models));
}

function getOpenRouterHeaders() {
  const referer = process.env.OPENROUTER_HTTP_REFERER || process.env.PUBLIC_URL || 'https://github.com/heyalerio/alerio-readwise-miniapp';
  const title = process.env.OPENROUTER_APP_TITLE || 'Alerio Readwise';
  return {
    ...(referer ? { 'HTTP-Referer': referer } : {}),
    ...(title ? { 'X-OpenRouter-Title': title } : {})
  };
}

function mergeOcrContextSnippets(...snippetGroups) {
  const merged = [];
  for (const group of snippetGroups) {
    for (const snippet of Array.isArray(group) ? group : []) {
      const text = normalizeNoteText(snippet?.text || '');
      if (!text) continue;
      if (merged.some((candidate) => normalizeNoteText(candidate.text).toLowerCase() === text.toLowerCase())) continue;
      merged.push({ ...snippet, text });
    }
  }
  return merged;
}

function mimeTypeForImagePath(filePath = '') {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function buildOcrWordFingerprint(text = '') {
  const words = String(text || '')
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/[^a-z0-9áéíóúüñç]+/gi, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !OCR_DEDUPE_STOP_WORDS.has(word));
  return Array.from(new Set(words));
}

function normalizeOcrContextText(text = '') {
  return String(text || '')
    .replace(/^title:\s*.*$/gim, '')
    .replace(/^author:\s*.*$/gim, '')
    .replace(/^page:\s*.*$/gim, '')
    .replace(/\[(?:highlight|note)\]/gi, '')
    .replace(/captured from mentra live.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, getVideoOcrContextSnippetMaxChars());
}

function isUsefulOcrContextSnippet(rawText = '', cleanedText = '', words = []) {
  if (words.length < getVideoOcrContextMinWords()) return false;
  const longWords = words.filter((word) => word.length >= 5).length;
  if (longWords < getVideoOcrContextMinLongWords()) return false;
  const raw = String(rawText || '');
  const symbolCount = (raw.match(/[=|\\/_<>~{}[\]¢¥§#]/g) || []).length;
  const symbolRatio = raw.length ? symbolCount / raw.length : 1;
  if (symbolRatio > getVideoOcrContextMaxSymbolRatio()) return false;
  return normalizeNoteText(cleanedText).length >= getVideoOcrContextMinChars();
}

function isDuplicateOcrText(leftWords = [], rightWords = []) {
  if (leftWords.length < getVideoOcrDedupeMinWords() || rightWords.length < getVideoOcrDedupeMinWords()) return false;
  const left = new Set(leftWords);
  const right = new Set(rightWords);
  let intersection = 0;
  for (const word of left) {
    if (right.has(word)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  const jaccard = union ? intersection / union : 0;
  const containment = intersection / Math.min(left.size, right.size);
  return jaccard >= getVideoOcrDedupeSimilarity() || containment >= getVideoOcrDedupeContainment();
}

async function resolveVideoContextDecision({ transcript = '', ocrSnippets = [], contextInterpreter } = {}) {
  if (!isVideoContextInterpretationEnabled() || !contextInterpreter) return buildHeuristicContextDecision({ transcript, ocrSnippets, provider: 'disabled' });
  try {
    return normalizeContextDecision(await contextInterpreter({ transcript, ocrSnippets }));
  } catch (error) {
    return buildHeuristicContextDecision({
      transcript,
      ocrSnippets,
      provider: 'heuristic_after_interpreter_failed',
      reason: normalizeReason(error)
    });
  }
}

export async function interpretVideoReviewContext({
  transcript = '',
  ocrSnippets = [],
  provider = process.env.READWISE_VIDEO_CONTEXT_PROVIDER || 'heuristic',
  fetchImpl = fetch
} = {}) {
  if (provider === 'off' || provider === 'disabled') {
    return buildHeuristicContextDecision({ transcript, ocrSnippets, provider: 'disabled' });
  }
  if (provider === 'openai') {
    try {
      return await interpretVideoReviewContextWithOpenAI({ transcript, ocrSnippets, fetchImpl });
    } catch (error) {
      return buildHeuristicContextDecision({
        transcript,
        ocrSnippets,
        provider: 'heuristic_after_openai_failed',
        reason: normalizeReason(error)
      });
    }
  }
  return buildHeuristicContextDecision({ transcript, ocrSnippets, provider: 'heuristic' });
}

async function interpretVideoReviewContextWithOpenAI({
  transcript = '',
  ocrSnippets = [],
  model = process.env.READWISE_VIDEO_CONTEXT_MODEL || process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
  apiKey = process.env.OPENAI_API_KEY,
  endpoint = process.env.OPENAI_CHAT_COMPLETIONS_URL || 'https://api.openai.com/v1/chat/completions',
  timeoutMs = Number(process.env.READWISE_VIDEO_CONTEXT_TIMEOUT_MS || 12000),
  fetchImpl = fetch
} = {}) {
  if (!apiKey) throw new Error('missing_openai_api_key');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 12000);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'Classify a book-video review context.',
              'Return compact JSON with keys: kind, summary, highlightText, noteText, taskText.',
              'kind must be one of: task, highlight, note, mixed, unknown.',
              'Do not invent book text. If OCR is noisy, say so in noteText.'
            ].join(' ')
          },
          {
            role: 'user',
            content: JSON.stringify({
              transcript: normalizeNoteText(transcript),
              ocrSnippets: normalizeOcrSnippetTexts(ocrSnippets)
            })
          }
        ]
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`openai_context_failed:${response.status}`);
    const payload = await response.json();
    return {
      provider: 'openai',
      model,
      ...parseContextDecisionPayload(payload?.choices?.[0]?.message?.content || '')
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseContextDecisionPayload(content = '') {
  try {
    return JSON.parse(String(content || '').trim());
  } catch (_error) {
    return { kind: 'unknown', summary: normalizeNoteText(content) };
  }
}

function buildHeuristicContextDecision({ transcript = '', ocrSnippets = [], provider = 'heuristic', reason = '' } = {}) {
  const text = normalizeNoteText([transcript, ...normalizeOcrSnippetTexts(ocrSnippets)].join(' ')).toLowerCase();
  const hasTask = /\b(todo|task|remind|reminder|follow up|fix|build|run|send|email|call|schedule|openclaw|codex|implement|debug)\b/.test(text);
  const hasHighlight = /\b(highlight|quote|passage|readwise|save this|save that|important line|marked|underlined)\b/.test(text) || normalizeOcrSnippetTexts(ocrSnippets).length > 0;
  const hasNote = /\b(note|idea|remember|context|thought|this means|connect this)\b/.test(text);
  const kind = hasTask && hasHighlight ? 'mixed' : hasTask ? 'task' : hasHighlight ? 'highlight' : hasNote ? 'note' : text ? 'note' : 'unknown';
  return normalizeContextDecision({
    provider,
    kind,
    summary: normalizeNoteText(transcript || normalizeOcrSnippetTexts(ocrSnippets).join(' ')),
    highlightText: hasHighlight ? normalizeNoteText(normalizeOcrSnippetTexts(ocrSnippets).join(' ')) : '',
    noteText: hasNote || kind === 'note' ? normalizeNoteText(transcript) : '',
    taskText: hasTask ? normalizeNoteText(transcript) : '',
    reason
  });
}

function normalizeContextDecision(decision = {}) {
  const kind = normalizeContextKind(decision.kind);
  return {
    provider: normalizeReason(decision.provider || 'heuristic'),
    ...(decision.model ? { model: normalizeReason(decision.model) } : {}),
    kind,
    summary: normalizeNoteText(decision.summary || ''),
    highlightText: normalizeNoteText(decision.highlightText || ''),
    noteText: normalizeNoteText(decision.noteText || ''),
    taskText: normalizeNoteText(decision.taskText || ''),
    ...(decision.reason ? { reason: normalizeReason(decision.reason) } : {})
  };
}

function normalizeContextKind(kind = '') {
  const normalized = String(kind || '').toLowerCase().trim();
  return ['task', 'highlight', 'note', 'mixed', 'unknown'].includes(normalized) ? normalized : 'unknown';
}

function normalizeOcrSnippetTexts(ocrSnippets = []) {
  return (Array.isArray(ocrSnippets) ? ocrSnippets : [])
    .map((snippet) => normalizeNoteText(snippet?.text || ''))
    .filter(Boolean);
}

const OCR_DEDUPE_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'from',
  'are',
  'was',
  'were',
  'you',
  'your',
  'not',
  'but',
  'have',
  'has',
  'had'
]);

function normalizeFrameQuality(result) {
  if (typeof result === 'number') return { provider: 'custom', sharpnessScore: Number.isFinite(result) ? result : null };
  const sharpnessScore = Number(result?.sharpnessScore);
  return {
    ...(result && typeof result === 'object' ? result : {}),
    sharpnessScore: Number.isFinite(sharpnessScore) ? sharpnessScore : null
  };
}

function normalizeFrameFingerprint(result) {
  const hash = normalizeFingerprintHash(
    typeof result === 'string' ? result : result?.fingerprint || result?.hash
  );
  return {
    ...(result && typeof result === 'object' ? result : {}),
    hash
  };
}

function isSelectableFrame(frame = {}, { minBytes, minSharpnessScore }) {
  const size = Number(frame.size || 0);
  if (Number.isFinite(minBytes) && minBytes > 0 && size > 0 && size < minBytes) return false;
  const sharpnessScore = getFrameSharpnessScore(frame);
  if (
    Number.isFinite(minSharpnessScore) &&
    minSharpnessScore > 0 &&
    Number.isFinite(sharpnessScore) &&
    sharpnessScore < minSharpnessScore
  ) {
    return false;
  }
  const brightRatio = getFrameBrightRatio(frame);
  const minBrightRatio = getVideoMinBrightRatio();
  if (Number.isFinite(brightRatio) && Number.isFinite(minBrightRatio) && brightRatio < minBrightRatio) return false;
  const darkRatio = getFrameDarkRatio(frame);
  const maxDarkRatio = getVideoMaxDarkRatio();
  if (Number.isFinite(darkRatio) && Number.isFinite(maxDarkRatio) && darkRatio > maxDarkRatio) return false;
  if (!frame.filePath && !frame.url) return false;
  return true;
}

function selectChronologicalSpread(
  frames = [],
  maxSelected = getVideoSelectedFrameCount(),
  dedupeOptions = {}
) {
  const limit = normalizeFrameSelectionLimit(maxSelected, frames.length);
  if (!limit || !frames.length) return [];
  if (frames.length <= limit) return selectUniqueFrames(frames, frames.length, dedupeOptions);
  if (limit === 1) return [frames[0]];

  const selectedIndexes = new Set();
  for (let step = 0; step < limit; step += 1) {
    selectedIndexes.add(Math.round((step * (frames.length - 1)) / (limit - 1)));
  }

  const selected = [];
  for (const index of Array.from(selectedIndexes).sort((a, b) => a - b)) {
    addSelectedFrame(selected, frames[index], limit, dedupeOptions);
  }

  for (let index = 0; selected.length < limit && index < frames.length; index += 1) {
    selectedIndexes.add(index);
    addSelectedFrame(selected, frames[index], limit, dedupeOptions);
  }

  return selected.sort((a, b) => a.index - b.index);
}

function selectChronologicalQualitySpread(
  frames = [],
  maxSelected = getVideoSelectedFrameCount(),
  dedupeOptions = {}
) {
  const limit = normalizeFrameSelectionLimit(maxSelected, frames.length);
  if (!limit || !frames.length) return [];
  if (shouldDedupeFrames(dedupeOptions)) {
    const dedupedFrames = selectUniqueFrames(frames, frames.length, dedupeOptions);
    if (dedupedFrames.length !== frames.length) {
      return selectChronologicalQualitySpread(dedupedFrames, maxSelected, { ...dedupeOptions, dedupeEnabled: false });
    }
  }
  if (frames.length <= limit) return selectUniqueFrames(frames, frames.length, dedupeOptions);

  const selected = [];
  for (let bucket = 0; bucket < limit; bucket += 1) {
    const start = Math.floor((bucket * frames.length) / limit);
    const end = Math.max(start + 1, Math.ceil(((bucket + 1) * frames.length) / limit));
    for (const candidate of frames.slice(start, end).sort(compareFrameQuality)) {
      if (addSelectedFrame(selected, candidate, limit, dedupeOptions)) break;
    }
  }

  for (const frame of [...frames].sort(compareFrameQuality)) {
    if (selected.length >= limit) break;
    addSelectedFrame(selected, frame, limit, dedupeOptions);
  }

  return selected.sort((a, b) => a.index - b.index);
}

function selectUniqueFrames(frames = [], limit = frames.length, dedupeOptions = {}) {
  if (!shouldDedupeFrames(dedupeOptions)) return frames.slice(0, limit);

  const selected = [];
  for (const frame of [...frames].sort(compareFrameQuality)) {
    addSelectedFrame(selected, frame, limit, dedupeOptions);
  }
  return selected.sort((a, b) => a.index - b.index);
}

function normalizeFrameSelectionLimit(maxSelected, fallbackLimit) {
  const parsed = Number(maxSelected);
  if (!Number.isFinite(parsed) || parsed <= 0) return Math.max(0, Number(fallbackLimit) || 0);
  return Math.max(0, Math.floor(parsed));
}

function addSelectedFrame(selected, frame, limit, dedupeOptions = {}) {
  if (!frame || selected.length >= limit || selected.some((candidate) => candidate.index === frame.index)) return false;
  if (isDuplicateFrame(frame, selected, dedupeOptions)) return false;
  selected.push(frame);
  return true;
}

function countNearDuplicateFrames(
  frames = [],
  {
    minBytes,
    minSharpnessScore,
    dedupeEnabled = isVideoFrameDedupeEnabled(),
    dedupeDistance = getVideoDedupeHashDistance(),
    dedupeLumaMad = getVideoDedupeLumaMad(),
    dedupeIndexWindow = getVideoDedupeMaxIndexGap()
  } = {}
) {
  if (!shouldDedupeFrames({ dedupeEnabled, dedupeDistance })) return 0;

  const unique = [];
  let duplicateCount = 0;
  for (const frame of frames
    .filter((candidate) => isSelectableFrame(candidate, { minBytes, minSharpnessScore }))
    .sort((a, b) => a.index - b.index)) {
    if (isDuplicateFrame(frame, unique, { dedupeEnabled, dedupeDistance, dedupeLumaMad, dedupeIndexWindow })) {
      duplicateCount += 1;
    } else {
      unique.push(frame);
    }
  }
  return duplicateCount;
}

function isDuplicateFrame(
  frame,
  selected = [],
  {
    dedupeEnabled = true,
    dedupeDistance = getVideoDedupeHashDistance(),
    dedupeLumaMad = getVideoDedupeLumaMad(),
    dedupeIndexWindow = getVideoDedupeMaxIndexGap()
  } = {}
) {
  const hash = getFrameFingerprintHash(frame);
  if (!dedupeEnabled || !hash) return false;
  const maxDistance = Number(dedupeDistance);
  if (!Number.isFinite(maxDistance) || maxDistance < 0) return false;
  const maxIndexDistance = Number(dedupeIndexWindow);

  return selected.some((candidate) => {
    const candidateHash = getFrameFingerprintHash(candidate);
    if (!candidateHash) return false;
    if (
      Number.isFinite(maxIndexDistance) &&
      maxIndexDistance >= 0 &&
      Math.abs(Number(frame.index) - Number(candidate.index)) > maxIndexDistance
    ) {
      return false;
    }
    if (hammingDistanceHex(hash, candidateHash) > maxDistance) return false;

    const maxLumaMad = Number(dedupeLumaMad);
    if (!Number.isFinite(maxLumaMad) || maxLumaMad < 0) return true;

    const lumaMad = meanAbsoluteDifference(getFrameFingerprintLumaVector(frame), getFrameFingerprintLumaVector(candidate));
    return Number.isFinite(lumaMad) && lumaMad <= maxLumaMad;
  });
}

function shouldDedupeFrames({ dedupeEnabled = true, dedupeDistance = getVideoDedupeHashDistance() } = {}) {
  const maxDistance = Number(dedupeDistance);
  return dedupeEnabled && Number.isFinite(maxDistance) && maxDistance >= 0;
}

async function removeRejectedCandidateFrames(candidateFrames = [], selectedFrames = []) {
  if (process.env.READWISE_VIDEO_KEEP_REJECTED_FRAMES === '1') return;
  const keep = new Set(selectedFrames.map((frame) => frame.filePath).filter(Boolean));
  for (const frame of candidateFrames) {
    if (!frame.filePath || keep.has(frame.filePath)) continue;
    await fs.rm(frame.filePath, { force: true });
  }
}

async function removeRejectedSelectedFrames(allSelectedFrames = [], keptSelectedFrames = []) {
  if (process.env.READWISE_VIDEO_KEEP_REJECTED_FRAMES === '1') return;
  const keep = new Set(keptSelectedFrames.map((frame) => frame.filePath).filter(Boolean));
  for (const frame of allSelectedFrames) {
    if (!frame.filePath || keep.has(frame.filePath)) continue;
    await fs.rm(frame.filePath, { force: true });
  }
}

async function transcribeVideoAudio({ videoPath, existingTranscript = '', audioExtractor, audioTranscriber }) {
  const existing = normalizeNoteText(existingTranscript);
  if (!isVideoAudioTranscriptionEnabled()) {
    return { text: existing, source: existing ? 'existing' : 'disabled' };
  }

  try {
    const audio = await audioExtractor({ videoPath });
    if (!audio?.audioBuffer?.byteLength) return { text: existing, source: existing ? 'existing' : 'no_audio' };
    const result = await audioTranscriber({
      audioBuffer: audio.audioBuffer,
      mimeType: audio.mimeType,
      filename: audio.filename,
      prompt: getVideoAudioTranscriptionPrompt()
    });
    const transcribed = normalizeNoteText(result?.text);
    if (!transcribed) return { text: existing, source: existing ? 'existing' : result?.skipped || 'empty_transcript' };
    if (!existing) return { text: transcribed, source: result?.provider || 'audio' };
    if (existing.toLowerCase().includes(transcribed.toLowerCase())) return { text: existing, source: 'existing' };
    return { text: `${existing}\n${transcribed}`.slice(0, 1000), source: `${result?.provider || 'audio'}+existing` };
  } catch (error) {
    return { text: existing, source: existing ? 'existing_audio_failed' : normalizeReason(error) };
  }
}

function buildProcessedVideoImageOnlyText(transcript = '', extractedHighlights = [], bookIdentity = {}) {
  const note = normalizeNoteText(transcript);
  const firstHighlight = Array.isArray(extractedHighlights) ? extractedHighlights.find((highlight) => normalizeHighlightText(highlight?.text)) : null;
  const title = normalizeBookIdentityText(bookIdentity.title);
  const author = normalizeBookIdentityText(bookIdentity.author);
  const highlightText = firstHighlight
    ? `[HIGHLIGHT] ${normalizeHighlightText(firstHighlight.text)}${firstHighlight.page ? `\nPAGE: ${normalizePageLabel(firstHighlight.page)}` : ''}`
    : '[HIGHLIGHT] OCR pending. Image-only video capture is ready. Use the selected high-quality page images in Readwise or manual review before sending anything to Readwise.';
  return [
    title ? `TITLE: ${title}` : '',
    author ? `AUTHOR: ${author}` : '',
    highlightText,
    note ? `[NOTE] ${note}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function resolveBookIdentity({ transcript = '', highlights = [] } = {}) {
  const fromTranscript = parseBookIdentityFromTranscript(transcript);
  if (isCompleteBookIdentity(fromTranscript)) {
    return { ...fromTranscript, status: 'confirmed', source: 'voice_transcript' };
  }

  const fromHighlights = pickBookIdentityFromHighlights(highlights);
  if (isCompleteBookIdentity(fromHighlights)) {
    return { ...fromHighlights, status: 'confirmed', source: 'vision_ocr' };
  }

  const partial = compactBookIdentity({ ...fromHighlights, ...fromTranscript });
  return {
    ...partial,
    status: 'missing',
    source: partial.title || partial.author ? 'partial' : 'none',
    required: true
  };
}

function pickBookIdentityFromHighlights(highlights = []) {
  const scored = new Map();
  for (const highlight of Array.isArray(highlights) ? highlights : []) {
    const title = normalizeBookIdentityText(highlight?.title);
    const author = normalizeBookIdentityText(highlight?.author);
    if (!title || !author) continue;
    const key = `${title}\n${author}`;
    const current = scored.get(key) || { title, author, score: 0 };
    current.score += 1 + Number(highlight?.confidence || 0);
    scored.set(key, current);
  }
  return Array.from(scored.values()).sort((a, b) => b.score - a.score)[0] || {};
}

function parseBookIdentityFromTranscript(transcript = '') {
  const text = normalizeNoteText(transcript);
  if (!text) return {};
  const patterns = [
    /\b(?:book|title)\s+(?:is|called)\s+["“]?([^"”]+?)["”]?\s+(?:by|from)\s+([A-Z][^.;!?]{1,120})/i,
    /\b(?:i(?:'m| am)?\s+reading|reading)\s+["“]?([^"”]+?)["”]?\s+(?:by|from)\s+([A-Z][^.;!?]{1,120})/i,
    /\b["“]([^"”]{2,160})["”]\s+by\s+([A-Z][^.;!?]{1,120})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    return compactBookIdentity({
      title: cleanupBookIdentitySegment(match[1]),
      author: cleanupBookIdentitySegment(match[2])
    });
  }
  return {};
}

function compactBookIdentity(identity = {}) {
  const title = normalizeBookIdentityText(identity.title);
  const author = normalizeBookIdentityText(identity.author);
  return {
    ...(title ? { title } : {}),
    ...(author ? { author } : {})
  };
}

function isCompleteBookIdentity(identity = {}) {
  return Boolean(normalizeBookIdentityText(identity.title) && normalizeBookIdentityText(identity.author));
}

function cleanupBookIdentitySegment(value = '') {
  return normalizeBookIdentityText(value)
    .replace(/\b(?:page|chapter|highlight|quote|note)\b.*$/i, '')
    .replace(/\s+(?:and|where|when|while)\s+.*$/i, '')
    .trim();
}

function normalizeBookIdentityText(value = '') {
  const text = normalizeNoteText(value)
    .replace(/^unknown\b.*$/i, '')
    .replace(/^null$/i, '')
    .replace(/^[\s:,-]+|[\s:,-]+$/g, '')
    .slice(0, 160);
  return text.length >= 2 ? text : '';
}

function buildVideoReviewNote(transcript = '', ocrSnippets = [], contextDecision = {}, extractedHighlights = []) {
  const parts = [normalizeNoteText(transcript)];
  const decision = formatContextDecision(contextDecision);
  if (decision) parts.push(decision);
  const highlightContext = formatExtractedHighlights(extractedHighlights);
  if (highlightContext) parts.push(highlightContext);
  const ocrContext = formatOcrSnippets(ocrSnippets);
  if (ocrContext) parts.push(ocrContext);
  return parts.filter(Boolean).join('\n');
}

function formatContextDecision(contextDecision = {}) {
  const kind = normalizeContextKind(contextDecision.kind);
  if (kind === 'unknown' && !contextDecision.summary && !contextDecision.taskText && !contextDecision.highlightText && !contextDecision.noteText) return '';
  const lines = [
    `Decision: ${kind}`,
    contextDecision.summary ? `Summary: ${normalizeNoteText(contextDecision.summary)}` : '',
    contextDecision.taskText ? `Task: ${normalizeNoteText(contextDecision.taskText)}` : '',
    contextDecision.highlightText ? `Highlight candidate: ${normalizeNoteText(contextDecision.highlightText)}` : '',
    contextDecision.noteText ? `Note: ${normalizeNoteText(contextDecision.noteText)}` : ''
  ].filter(Boolean);
  return lines.join('\n').slice(0, getVideoContextDecisionMaxChars());
}

function formatOcrSnippets(ocrSnippets = []) {
  const snippets = (Array.isArray(ocrSnippets) ? ocrSnippets : [])
    .map((snippet, index) => {
      const text = normalizeNoteText(snippet?.text || '');
      if (!text) return '';
      const frameIndex = Number.isFinite(Number(snippet?.frameIndex)) ? Number(snippet.frameIndex) + 1 : index + 1;
      const page = normalizePageLabel(snippet?.page);
      return `OCR page ${frameIndex}${page ? ` (p. ${page})` : ''}: ${text}`;
    })
    .filter(Boolean);
  if (!snippets.length) return '';
  return snippets.join('\n').slice(0, getVideoOcrContextMaxChars());
}

function formatExtractedHighlights(extractedHighlights = []) {
  const lines = (Array.isArray(extractedHighlights) ? extractedHighlights : [])
    .map((highlight, index) => {
      const text = normalizeHighlightText(highlight?.text || '');
      if (!text) return '';
      const frameIndex = Number.isFinite(Number(highlight?.frameIndex)) ? Number(highlight.frameIndex) + 1 : index + 1;
      const page = normalizePageLabel(highlight?.page);
      const location = page ? `p. ${page}` : `frame ${frameIndex}`;
      return `Pen highlight ${location}: ${text}`;
    })
    .filter(Boolean);
  if (!lines.length) return '';
  return lines.join('\n').slice(0, getVideoOcrContextMaxChars());
}

function normalizeNoteText(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

function compareFrameQuality(a, b) {
  const sharpnessDelta = (getFrameSharpnessScore(b) || 0) - (getFrameSharpnessScore(a) || 0);
  if (sharpnessDelta) return sharpnessDelta;
  return Number(b.size || 0) - Number(a.size || 0);
}

function getFrameFingerprintHash(frame = {}) {
  return normalizeFingerprintHash(frame.fingerprint?.hash || frame.fingerprint || frame.hash);
}

function getFrameFingerprintLumaVector(frame = {}) {
  const vector = frame.fingerprint?.lumaVector || frame.fingerprint?.luma || frame.lumaVector;
  return Array.isArray(vector) ? vector.filter((value) => Number.isFinite(Number(value))).map(Number) : [];
}

function normalizeFingerprintHash(value = '') {
  const hash = String(value || '').toLowerCase().replace(/[^a-f0-9]/g, '');
  return hash.length >= 2 ? hash : '';
}

function buildDifferenceFingerprint(buffer, width, height) {
  const expectedBytes = width * height;
  if (!Buffer.isBuffer(buffer) || buffer.length < expectedBytes) throw new Error('fingerprint_frame_too_small');

  const bytes = [];
  let current = 0;
  let bit = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const left = buffer[y * width + x];
      const right = buffer[y * width + x + 1];
      if (left > right) current |= 1 << (7 - bit);
      bit += 1;
      if (bit === 8) {
        bytes.push(current);
        current = 0;
        bit = 0;
      }
    }
  }
  if (bit > 0) bytes.push(current);
  return {
    hash: Buffer.from(bytes).toString('hex'),
    lumaVector: buildNormalizedLumaVector(buffer.subarray(0, expectedBytes)),
    ...buildLumaStats(buffer.subarray(0, expectedBytes))
  };
}

function buildLumaStats(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return { lumaMean: null, lumaStdDev: null, brightRatio: null, darkRatio: null };
  }
  const values = Array.from(buffer);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    lumaMean: Math.round(mean * 1000) / 1000,
    lumaStdDev: Math.round(Math.sqrt(variance) * 1000) / 1000,
    brightRatio: Math.round((values.filter((value) => value >= getVideoBrightPixelThreshold()).length / values.length) * 1000) / 1000,
    darkRatio: Math.round((values.filter((value) => value <= getVideoDarkPixelThreshold()).length / values.length) * 1000) / 1000
  };
}

function buildNormalizedLumaVector(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return [];
  const mean = buffer.reduce((sum, value) => sum + value, 0) / buffer.length;
  return Array.from(buffer, (value) => Math.round(value - mean));
}

function meanAbsoluteDifference(left = [], right = []) {
  if (!left.length || !right.length) return Number.POSITIVE_INFINITY;
  const length = Math.min(left.length, right.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += Math.abs(Number(left[index]) - Number(right[index]));
  }
  return total / length;
}

function hammingDistanceHex(left = '', right = '') {
  const a = normalizeFingerprintHash(left);
  const b = normalizeFingerprintHash(right);
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const length = Math.min(a.length, b.length);
  let distance = Math.abs(a.length - b.length) * 4;
  for (let index = 0; index < length; index += 1) {
    distance += HEX_BIT_COUNTS[Number.parseInt(a[index], 16) ^ Number.parseInt(b[index], 16)];
  }
  return distance;
}

const HEX_BIT_COUNTS = Object.freeze([0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4]);

function getFrameSharpnessScore(frame = {}) {
  const sharpnessScore = Number(frame.quality?.sharpnessScore ?? frame.sharpnessScore);
  return Number.isFinite(sharpnessScore) ? sharpnessScore : null;
}

function getFrameBrightRatio(frame = {}) {
  const value = Number(frame.fingerprint?.brightRatio ?? frame.brightRatio);
  return Number.isFinite(value) ? value : null;
}

function getFrameDarkRatio(frame = {}) {
  const value = Number(frame.fingerprint?.darkRatio ?? frame.darkRatio);
  return Number.isFinite(value) ? value : null;
}

function getBestSharpnessScore(frames = []) {
  const scores = frames.map(getFrameSharpnessScore).filter(Number.isFinite);
  if (!scores.length) return null;
  return Math.round(Math.max(...scores) * 1000) / 1000;
}

function processingReason({ selectedFrameCount = 0 } = {}) {
  if (!selectedFrameCount) return 'no_sharp_frames_selected';
  return 'selected_quality_frames';
}

function normalizeReason(error) {
  return String(error?.message || error || 'worker_failed')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_.:-]/g, '_')
    .slice(0, 160);
}

async function getVideoDurationSeconds({ videoPath, execFileImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileImpl(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        videoPath
      ],
      {
        timeout: getVideoProbeTimeoutMs(),
        maxBuffer: 64 * 1024
      }
    );
    const parsed = Number(String(stdout || '').trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function buildCandidateFrameFilter(sampleIntervalSeconds) {
  const interval = formatFilterNumber(sampleIntervalSeconds);
  return `select=eq(n\\,0)+gte(t-prev_selected_t\\,${interval})`;
}

function formatFilterNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.max(0.1, number).toFixed(3)).replace(/\.?0+$/, '') : '3';
}

function getExplicitVideoCandidateFrameCount() {
  const raw = process.env.READWISE_VIDEO_CANDIDATE_FRAME_COUNT || process.env.READWISE_VIDEO_FRAME_COUNT;
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function getVideoCandidateFrameCountFromInterval(durationSeconds, sampleIntervalSeconds, explicitCandidateFrameCount = null) {
  const explicit = Number(explicitCandidateFrameCount);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);

  const max = getMaxVideoCandidateFrameCount();
  if (max) return max;

  const duration = Number(durationSeconds);
  const interval = Number(sampleIntervalSeconds);
  if (Number.isFinite(duration) && duration > 0 && Number.isFinite(interval) && interval > 0) {
    return Math.max(1, Math.ceil(duration / interval) + 1);
  }

  const fallback = Number(process.env.READWISE_VIDEO_FALLBACK_CANDIDATE_FRAME_COUNT || 240);
  return Number.isFinite(fallback) && fallback > 0 ? Math.floor(fallback) : 240;
}

function getMaxVideoCandidateFrameCount() {
  const max = Number(process.env.READWISE_VIDEO_MAX_CANDIDATE_FRAME_COUNT || 0);
  return Number.isFinite(max) && max > 0 ? Math.floor(max) : null;
}

function getVideoCandidateFrameCount(durationSeconds, sampleIntervalSeconds, explicitCandidateFrameCount = null) {
  return getVideoCandidateFrameCountFromInterval(durationSeconds, sampleIntervalSeconds, explicitCandidateFrameCount);
}

function getVideoCandidateSampleIntervalSeconds(durationSeconds, candidateFrameCount = null) {
  const explicit = Number(process.env.READWISE_VIDEO_SAMPLE_INTERVAL_SECONDS || 0);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(0.25, explicit);
  const duration = Number(durationSeconds);
  const count = Number(candidateFrameCount);
  if (Number.isFinite(duration) && duration > 0 && Number.isFinite(count) && count > 1) {
    return Math.max(0.5, duration / count);
  }
  return 10;
}

function getVideoFrameTimeoutMs() {
  const parsed = Number(process.env.READWISE_VIDEO_FRAME_TIMEOUT_MS || 30000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 30000;
}

function getVideoProbeTimeoutMs() {
  const parsed = Number(process.env.READWISE_VIDEO_PROBE_TIMEOUT_MS || 5000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5000;
}

function getVideoSelectedFrameCount() {
  const raw = process.env.READWISE_VIDEO_SELECTED_FRAME_COUNT || process.env.READWISE_VIDEO_BOOK_FRAME_COUNT;
  if (raw === undefined || raw === '') return Number.POSITIVE_INFINITY;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Number.POSITIVE_INFINITY;
}

function getVideoMinFrameBytes() {
  const parsed = Number(process.env.READWISE_VIDEO_MIN_FRAME_BYTES || 1500);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1500;
}

function getVideoMinSharpnessScore() {
  const parsed = Number(process.env.READWISE_VIDEO_MIN_SHARPNESS_SCORE || 3.25);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3.25;
}

function getVideoMinBrightRatio() {
  const parsed = Number(process.env.READWISE_VIDEO_MIN_BRIGHT_RATIO || 0.08);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(1, parsed) : 0.08;
}

function getVideoMaxDarkRatio() {
  const parsed = Number(process.env.READWISE_VIDEO_MAX_DARK_RATIO || 0.4);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(1, parsed) : 0.4;
}

function getVideoBrightPixelThreshold() {
  const parsed = Number(process.env.READWISE_VIDEO_BRIGHT_PIXEL_THRESHOLD || 135);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(255, Math.floor(parsed))) : 135;
}

function getVideoDarkPixelThreshold() {
  const parsed = Number(process.env.READWISE_VIDEO_DARK_PIXEL_THRESHOLD || 55);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(255, Math.floor(parsed))) : 55;
}

function isVideoQualityScoringEnabled() {
  return process.env.READWISE_VIDEO_QUALITY_SCORING !== '0';
}

function isVideoReviewImageEnhancementEnabled() {
  return process.env.READWISE_VIDEO_REVIEW_IMAGE_ENHANCE !== '0';
}

function getVideoReviewImageScale() {
  const parsed = Number(process.env.READWISE_VIDEO_REVIEW_IMAGE_SCALE || 3);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(4, parsed) : 3;
}

function getVideoReviewImageMaxLongEdge() {
  const parsed = Number(process.env.READWISE_VIDEO_REVIEW_IMAGE_MAX_LONG_EDGE || 3840);
  return Number.isFinite(parsed) && parsed >= 1200 ? Math.min(6000, Math.floor(parsed)) : 3840;
}

function getVideoQualityRoiFilter() {
  const mode = String(process.env.READWISE_VIDEO_QUALITY_ROI || 'book_area').toLowerCase();
  if (mode === 'full' || mode === 'none') return 'null';
  if (mode === 'lower') return 'crop=iw:ih*0.65:0:ih*0.35';
  if (mode === 'page_wide') return 'crop=iw*0.86:ih*0.78:iw*0.07:ih*0.18';
  return 'crop=iw*0.65:ih*0.65:iw*0.18:ih*0.35';
}

function getVideoReviewImageCropFilter() {
  const mode = String(process.env.READWISE_VIDEO_REVIEW_IMAGE_CROP || 'page_wide').toLowerCase();
  if (mode === 'full' || mode === 'none') return '';
  if (mode === 'lower') return 'crop=iw:ih*0.65:0:ih*0.35';
  if (mode === 'page_wide') return 'crop=iw*0.86:ih*0.78:iw*0.07:ih*0.18';
  return 'crop=iw*0.65:ih*0.65:iw*0.18:ih*0.35';
}

function getVideoQualityTimeoutMs() {
  const parsed = Number(process.env.READWISE_VIDEO_QUALITY_TIMEOUT_MS || 3000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3000;
}

function isVideoFrameDedupeEnabled() {
  return process.env.READWISE_VIDEO_DEDUPE !== '0';
}

function getVideoDedupeHashDistance() {
  const parsed = Number(process.env.READWISE_VIDEO_DEDUPE_HASH_DISTANCE || process.env.READWISE_VIDEO_DEDUPE_DISTANCE || 90);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 90;
}

function getVideoDedupeLumaMad() {
  const parsed = Number(process.env.READWISE_VIDEO_DEDUPE_LUMA_MAD || 35);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 35;
}

function getVideoDedupeMaxIndexGap() {
  const parsed = Number(process.env.READWISE_VIDEO_DEDUPE_MAX_INDEX_GAP || process.env.READWISE_VIDEO_DEDUPE_INDEX_WINDOW || 12);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 12;
}

function getVideoFingerprintSize() {
  const parsed = Number(process.env.READWISE_VIDEO_FINGERPRINT_SIZE || 16);
  return Number.isFinite(parsed) && parsed >= 8 ? Math.min(32, Math.floor(parsed)) : 16;
}

function getVideoFingerprintTimeoutMs() {
  const parsed = Number(process.env.READWISE_VIDEO_DEDUPE_TIMEOUT_MS || process.env.READWISE_VIDEO_FINGERPRINT_TIMEOUT_MS || 2000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 2000;
}

function isVideoOcrDedupeEnabled() {
  return process.env.READWISE_VIDEO_OCR_DEDUPE === '1';
}

function isVideoHighlightOcrEnabled() {
  return process.env.READWISE_VIDEO_HIGHLIGHT_OCR === '1';
}

function isVideoContextInterpretationEnabled() {
  return process.env.READWISE_VIDEO_CONTEXT_INTERPRETATION !== '0';
}

function getVideoContextDecisionMaxChars() {
  const parsed = Number(process.env.READWISE_VIDEO_CONTEXT_DECISION_MAX_CHARS || 700);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 700;
}

function getVideoOcrDedupeTimeoutMs() {
  const parsed = Number(process.env.READWISE_VIDEO_OCR_DEDUPE_TIMEOUT_MS || process.env.LOCAL_BOOK_OCR_TIMEOUT_MS || process.env.LOCAL_IMAGE_OCR_TIMEOUT_MS || 5000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5000;
}

function getVideoOcrDedupeLang() {
  return process.env.READWISE_VIDEO_OCR_DEDUPE_LANG || process.env.LOCAL_IMAGE_OCR_LANG || 'eng';
}

function getVideoOcrDedupeMinWords() {
  const parsed = Number(process.env.READWISE_VIDEO_OCR_DEDUPE_MIN_WORDS || 8);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 8;
}

function getVideoOcrDedupeSimilarity() {
  const parsed = Number(process.env.READWISE_VIDEO_OCR_DEDUPE_SIMILARITY || 0.72);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(1, parsed) : 0.72;
}

function getVideoOcrDedupeContainment() {
  const parsed = Number(process.env.READWISE_VIDEO_OCR_DEDUPE_CONTAINMENT || 0.82);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(1, parsed) : 0.82;
}

function getVideoOcrDedupeMaxFrames() {
  const parsed = Number(process.env.READWISE_VIDEO_OCR_DEDUPE_MAX_FRAMES || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Number.POSITIVE_INFINITY;
}

function getVideoOcrContextMaxSnippets() {
  const parsed = Number(process.env.READWISE_VIDEO_OCR_CONTEXT_MAX_SNIPPETS || 8);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 8;
}

function getVideoOcrContextMinWords() {
  const parsed = Number(process.env.READWISE_VIDEO_OCR_CONTEXT_MIN_WORDS || 8);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 8;
}

function getVideoOcrContextMinLongWords() {
  const parsed = Number(process.env.READWISE_VIDEO_OCR_CONTEXT_MIN_LONG_WORDS || 4);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 4;
}

function getVideoOcrContextMinChars() {
  const parsed = Number(process.env.READWISE_VIDEO_OCR_CONTEXT_MIN_CHARS || 40);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 40;
}

function getVideoOcrContextMaxSymbolRatio() {
  const parsed = Number(process.env.READWISE_VIDEO_OCR_CONTEXT_MAX_SYMBOL_RATIO || 0.08);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(1, parsed) : 0.08;
}

function getVideoOcrContextSnippetMaxChars() {
  const parsed = Number(process.env.READWISE_VIDEO_OCR_CONTEXT_SNIPPET_MAX_CHARS || 240);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 240;
}

function getVideoOcrContextMaxChars() {
  const parsed = Number(process.env.READWISE_VIDEO_OCR_CONTEXT_MAX_CHARS || 1200);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1200;
}

function getVideoHighlightOcrTimeoutMs() {
  const parsed = Number(process.env.READWISE_VIDEO_HIGHLIGHT_OCR_TIMEOUT_MS || 20000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20000;
}

function getVideoHighlightOcrMaxFrames() {
  const parsed = Number(process.env.READWISE_VIDEO_HIGHLIGHT_OCR_MAX_FRAMES || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Number.POSITIVE_INFINITY;
}

function getVideoHighlightOcrMaxHighlights() {
  const parsed = Number(process.env.READWISE_VIDEO_HIGHLIGHT_OCR_MAX_HIGHLIGHTS || 80);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 80;
}

function shouldRequireMarkedHighlights() {
  return process.env.READWISE_VIDEO_HIGHLIGHT_OCR_MARKED_ONLY !== '0';
}

function getVideoEnhanceTimeoutMs() {
  const parsed = Number(process.env.READWISE_VIDEO_ENHANCE_TIMEOUT_MS || 5000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5000;
}

function getFfmpegThreads() {
  const parsed = Number(process.env.READWISE_VIDEO_FFMPEG_THREADS || 1);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(2, Math.floor(parsed)) : 1;
}

function isVideoAudioTranscriptionEnabled() {
  return process.env.READWISE_VIDEO_AUDIO_TRANSCRIPTION !== '0';
}

function getVideoAudioMaxSeconds() {
  const parsed = Number(process.env.READWISE_VIDEO_AUDIO_MAX_SECONDS || 90);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(600, Math.floor(parsed)) : 90;
}

function getVideoAudioExtractTimeoutMs() {
  const parsed = Number(process.env.READWISE_VIDEO_AUDIO_EXTRACT_TIMEOUT_MS || 30000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 30000;
}

function getVideoAudioTranscriptionPrompt() {
  return (
    process.env.READWISE_VIDEO_AUDIO_TRANSCRIPTION_PROMPT ||
    'Transcribe the reader note from a Mentra book capture. Preserve book titles, quotes, page numbers, and action notes. Return concise plain text.'
  );
}
