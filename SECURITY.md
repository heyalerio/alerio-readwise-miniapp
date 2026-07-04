# Security

Do not commit `.env`, `data/`, recordings, pending highlight stores, reading context, Telegram tokens, Readwise tokens, Mentra API keys, or RTMP secrets.

Production deployments should set:

- `READWISE_REVIEW_TOKEN`
- `READWISE_MEDIA_TOKEN_SECRET`
- `READWISE_RTMP_INGEST_SECRET`
- `MENTRA_BRIDGE_TOKEN` when accepting bridge uploads
- `READWISE_TELEGRAM_FORWARD_TOKEN` when accepting Telegram callback forwards

`data/reading-context.json` can contain private reading history, including book titles, authors, pages, timestamps, and draft ids.

Report security issues privately to the project maintainer before opening a public issue.
