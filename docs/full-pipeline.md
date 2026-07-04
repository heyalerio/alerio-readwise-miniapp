# Full Pipeline

This repo includes both halves of the Alerio Readwise process:

- the web mini app that records and stores Mentra video/audio
- the separate worker that extracts frames, OCRs highlights, transcribes optional notes, resolves book identity, and prepares approval-gated Readwise candidates

The split is intentional. Recording stays fast and reliable, while CPU/API-heavy frame and OCR work runs in a separate process.

## Requirements

- Node.js 20-23
- `ffmpeg` and `ffprobe` on `PATH`
- a public HTTPS URL for the Mentra mini app
- direct TCP routing for RTMP ingest if you use glasses streaming
- one OCR path:
  - OpenAI-compatible vision model via `OPENAI_API_KEY`
  - OpenRouter vision model via `OPENROUTER_API_KEY`
  - OpenClaw CLI available as `openclaw`
- optional local OCR dedupe with `tesseract`
- optional Telegram bot for review cards
- optional Readwise API token for approved writes

## Process

1. Mentra opens the mini app.
2. Glasses button starts a direct RTMP stream.
3. Glasses button stops the stream.
4. The web app remuxes the raw stream to MP4 and extracts M4A audio.
5. The web app stores both files and creates a queued draft.
6. The worker finds queued drafts.
7. The worker samples candidate frames with `ffmpeg`.
8. Frames are scored for sharpness/brightness, deduped, cropped, and enhanced.
9. The OCR provider extracts marked/underlined book passages.
10. Audio is optionally transcribed.
11. The worker resolves title/author from voice, vision, active reading context, or reading history.
12. Telegram receives separate review cards for book highlights and voice notes.
13. Approving a highlight writes to Readwise only when live writes and approvals are enabled.

## Run Locally

Terminal 1:

```bash
npm install
npm run setup
npm run doctor
npm run dev:all
```

`npm run doctor` is intentionally strict for the real glasses pipeline. It will tell you which secrets, hostnames, or binaries are missing without printing any secret values.

For production-style local testing, run the processes separately.

Terminal 1:

```bash
npm start
```

Terminal 2:

```bash
npm run worker:video
```

For one queued recording:

```bash
npm run worker:video:once
```

For a specific draft:

```bash
node src/video-worker.js --once --id highlight_123
```

## Sandbox Testing

Use the sandbox suite before adding real credentials:

```bash
npm run test:sandbox
```

The sandbox suite loads `.env.sandbox.example`, uses fake tokens, disables external API providers, runs `doctor`, runs syntax checks, and runs the full test suite. It is the same command used by the GitHub Actions workflow in `.github/workflows/ci.yml`.

Real keys should never be committed. Put them in local `.env` for manual testing, or in GitHub Actions secrets if you add a private integration workflow. Suggested secret names:

- `MENTRA_API_KEY`
- `READWISE_TOKEN`
- `READWISE_TELEGRAM_BOT_TOKEN`
- `READWISE_TELEGRAM_CHAT_ID`
- `READWISE_TELEGRAM_FORWARD_TOKEN`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`

## Minimal Full-Pipeline Config

Set the normal Mentra/server values first:

```dotenv
MENTRA_PACKAGE_NAME=com.example.mentra.bookreadwise
MENTRA_API_KEY=
PUBLIC_URL=https://readwise.example.com
READWISE_REVIEW_TOKEN=
READWISE_MEDIA_TOKEN_SECRET=
```

Enable stream recording:

```dotenv
READWISE_VIDEO_STREAM_CAPTURE=1
READWISE_RTMP_INGEST_ENABLED=1
READWISE_RTMP_PUBLIC_HOST=rtmp.example.com
READWISE_RTMP_INGEST_PORT=1935
READWISE_RTMP_INGEST_SECRET=
READWISE_RTMP_RECORD_DIR=./data/rtmp-recordings
FFMPEG_PATH=ffmpeg
```

Enable the worker OCR path:

```dotenv
READWISE_VIDEO_HIGHLIGHT_OCR=1
READWISE_VIDEO_HIGHLIGHT_OCR_PROVIDER=openai
OPENAI_API_KEY=
READWISE_VIDEO_HIGHLIGHT_OCR_MODEL=
```

Or use OpenRouter:

```dotenv
READWISE_VIDEO_HIGHLIGHT_OCR=1
READWISE_VIDEO_HIGHLIGHT_OCR_PROVIDER=openrouter
OPENROUTER_API_KEY=
OPENROUTER_VISION_MODEL=
```

Or use OpenClaw:

```dotenv
READWISE_VIDEO_HIGHLIGHT_OCR=1
READWISE_VIDEO_HIGHLIGHT_OCR_PROVIDER=openclaw
READWISE_VIDEO_HIGHLIGHT_OCR_MODEL=openrouter/auto
```

Optional audio transcription:

```dotenv
READWISE_VIDEO_AUDIO_TRANSCRIPTION=1
AUDIO_TRANSCRIPTION_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_TRANSCRIPTION_MODEL=
```

Optional Telegram review cards:

```dotenv
READWISE_TELEGRAM_ENABLED=1
READWISE_TELEGRAM_BOT_TOKEN=
READWISE_TELEGRAM_CHAT_ID=
READWISE_TELEGRAM_FORWARD_TOKEN=
```

Optional live Readwise writes:

```dotenv
READWISE_TOKEN=
READWISE_APPROVAL_ENABLED=1
READWISE_LIVE_WRITES=1
```

Keep `READWISE_LIVE_WRITES=0` until you have approved the Telegram review flow with test recordings.

## Worker Tuning

Useful defaults are in `.env.example`. These are the main knobs:

```dotenv
READWISE_VIDEO_WORKER_INTERVAL_MS=10000
READWISE_VIDEO_WORKER_LIMIT=1
READWISE_VIDEO_CANDIDATE_FRAME_COUNT=
READWISE_VIDEO_SAMPLE_INTERVAL_SECONDS=
READWISE_VIDEO_SELECTED_FRAME_COUNT=
READWISE_VIDEO_MIN_SHARPNESS_SCORE=3.25
READWISE_VIDEO_DEDUPE=1
READWISE_VIDEO_OCR_DEDUPE=1
READWISE_VIDEO_HIGHLIGHT_OCR_MAX_FRAMES=
READWISE_VIDEO_HIGHLIGHT_OCR_MAX_HIGHLIGHTS=80
READWISE_VIDEO_FFMPEG_THREADS=1
```

For long recordings, prefer sampling by interval or candidate count instead of trying to OCR every frame.

## Reading Context

The worker will not send `Unknown Book` to Readwise. It resolves book identity in this order:

1. complete title and author from transcript
2. complete title and author from OCR
3. active reading context
4. fuzzy match against recent reading history
5. block approval until the title and author are known

The context store defaults to:

```dotenv
READWISE_READING_CONTEXT_PATH=./data/reading-context.json
```

That file can contain private reading history and is intentionally ignored by git.

## Deploy Shape

Run the web app and worker as separate processes:

```bash
npm start
npm run worker:video
```

The two processes share:

- `MEDIA_DIR`
- `HIGHLIGHT_STORE_PATH`
- `READWISE_READING_CONTEXT_PATH`

If you deploy with a process manager, restart both processes after code or environment changes.
