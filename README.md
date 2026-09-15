# yt-txt-worker

Telegram bot on Cloudflare Workers that extracts existing YouTube captions through a native InnerTube multi-client fallback pipeline and sends a cleaned TXT file.

## Extraction flow

1. Validate the YouTube URL and extract the 11-character video ID.
2. Call the InnerTube player endpoint sequentially with at most five profiles: ANDROID, IOS, TVHTML5, MWEB, and WEB.
3. Continue to the next profile after bot detection, HTTP errors, malformed JSON, missing captions, or non-playable responses.
4. Stop when `playerCaptionsTracklistRenderer.captionTracks` is available.
5. Rank manual tracks before `kind=asr`, while preferring the default caption index.
6. Download only the caption track, trying JSON3, then WebVTT, then XML.
7. Clean timestamps, markup, entities, duplicates, and rolling overlap.
8. Generate and upload the TXT file entirely in memory.

No video/audio is downloaded. The project uses no browser automation, Python, subprocess, yt-dlp, Docker, VPS, or third-party transcript API.

## Install and test

```bash
npm install
npm test
npm run deploy:check
```

Unit tests are fully mocked and do not contact live YouTube.

## Secrets and variables

Required existing secret:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

Optional InnerTube API key, only if keyless requests are rejected:

```bash
npx wrangler secret put YOUTUBE_INNERTUBE_API_KEY
```

Optional existing Telegram webhook verification secret:

```bash
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Optional `YOUTUBE_CLIENTS_JSON` can override the client profiles without changing source code. It must be a JSON array with `name`, `clientName`, `clientId`, `clientVersion`, `userAgent`, and optional `extra` fields.

## Deploy

```bash
npm install
npm test
npm run deploy:check
npx wrangler deploy
```

The Worker remains named `yt-txt-worker`. Existing routes and Telegram flow are unchanged:

- `GET /` — health check
- `POST /webhook` — Telegram webhook

Deploying the same Worker name preserves the existing workers.dev URL and webhook destination.

## Live test

1. Deploy the Worker.
2. Open Cloudflare Workers & Pages → `yt-txt-worker` → Logs.
3. Send `/start` to the bot.
4. Send the problematic URL containing video ID `Qtl8lJwbd4g`.
5. Confirm the bot sends the progress message and then a TXT file or a classified Persian error.
6. Inspect structured events in order:
   - `youtube.transcript.start`
   - `youtube.innertube.client_attempt`
   - `youtube.innertube.response`
   - `youtube.caption_tracks.found`
   - `youtube.caption_track.selected`
   - `youtube.transcript.success` or `youtube.transcript.failure`

No tokens, API keys, cookies, authorization headers, Telegram chat IDs, or other user identifiers are included in YouTube extraction logs.

## Important limitation

InnerTube is an internal YouTube interface rather than a guaranteed public contract. Client versions are centralized in `YOUTUBE_CLIENTS` and can be overridden with `YOUTUBE_CLIENTS_JSON`. Cloudflare egress can still be blocked by YouTube; if every profile is blocked, the bot returns the dedicated bot-detection message instead of incorrectly reporting the video as private.
