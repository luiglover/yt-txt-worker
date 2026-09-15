const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const TELEGRAM_API = "https://api.telegram.org";
const START_TEXT = "لینک ویدیوی YouTube را ارسال کنید تا متن آن استخراج و به صورت فایل TXT برای شما ارسال شود.";

export const ERROR_CATEGORIES = Object.freeze({
  BOT_DETECTION: "BOT_DETECTION",
  VIDEO_UNAVAILABLE: "VIDEO_UNAVAILABLE",
  NO_CAPTIONS: "NO_CAPTIONS",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  PARSE_ERROR: "PARSE_ERROR",
  TRANSCRIPT_TOO_LARGE: "TRANSCRIPT_TOO_LARGE",
});

export const YOUTUBE_CLIENTS = Object.freeze([
  {
    name: "ANDROID",
    clientName: "ANDROID",
    clientId: "3",
    clientVersion: "20.10.38",
    userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 15) gzip",
    extra: { androidSdkVersion: 35, osName: "Android", osVersion: "15", platform: "MOBILE" },
  },
  {
    name: "IOS",
    clientName: "IOS",
    clientId: "5",
    clientVersion: "20.10.4",
    userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)",
    extra: { deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2", platform: "MOBILE" },
  },
  {
    name: "TVHTML5",
    clientName: "TVHTML5",
    clientId: "7",
    clientVersion: "7.20250312.18.00",
    userAgent: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
    extra: { platform: "TV" },
  },
  {
    name: "MWEB",
    clientName: "MWEB",
    clientId: "2",
    clientVersion: "2.20250311.03.00",
    userAgent: "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 Chrome/133.0 Mobile Safari/537.36",
    extra: { osName: "Android", osVersion: "15", platform: "MOBILE" },
  },
  {
    name: "WEB",
    clientName: "WEB",
    clientId: "1",
    clientVersion: "2.20250312.04.00",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/133.0 Safari/537.36",
    extra: { osName: "Windows", osVersion: "10.0", platform: "DESKTOP" },
  },
]);

export class YouTubeExtractionError extends Error {
  constructor(category, message, details = {}) {
    super(message);
    this.name = "YouTubeExtractionError";
    this.category = category;
    this.details = details;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("YouTube Transcript Bot is running.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      if (!env.TELEGRAM_BOT_TOKEN) {
        console.error("TELEGRAM_BOT_TOKEN is not configured");
        return new Response("Server is not configured", { status: 500 });
      }

      if (env.TELEGRAM_WEBHOOK_SECRET) {
        const supplied = request.headers.get("x-telegram-bot-api-secret-token");
        if (supplied !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      if (await isDuplicateUpdate(update.update_id)) return new Response("OK");
      ctx.waitUntil(handleUpdate(update, env));
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function handleUpdate(update, env) {
  const message = update.message;
  const chatId = message?.chat?.id;
  const text = message?.text?.trim();
  if (!chatId || !text) return;

  try {
    if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
      await sendMessage(env, chatId, START_TEXT);
      return;
    }

    const videoId = extractVideoId(text);
    if (!videoId) {
      await sendMessage(env, chatId, "❌ لطفاً یک لینک معتبر YouTube ارسال کنید.");
      return;
    }

    if (!(await consumeRateLimit(chatId, env))) {
      await sendMessage(env, chatId, "⚠️ تعداد درخواست‌ها زیاد است. لطفاً کمی بعد دوباره امتحان کنید.");
      return;
    }

    await sendMessage(env, chatId, "⏳ در حال استخراج متن ویدیو...");
    const { title, text: transcript } = await getYouTubeTranscript(videoId, env);
    const bytes = new TextEncoder().encode(transcript);

    if (bytes.byteLength > 45 * 1024 * 1024) {
      throw new YouTubeExtractionError(ERROR_CATEGORIES.TRANSCRIPT_TOO_LARGE, "Transcript exceeds upload safety limit");
    }

    await sendDocument(env, chatId, bytes, sanitizeFilename(title || "YouTube Transcript"));
    await sendMessage(env, chatId, "✅ متن ویدیو آماده شد.");
  } catch (error) {
    const category = error instanceof YouTubeExtractionError ? error.category : ERROR_CATEGORIES.UPSTREAM_ERROR;
    console.error(JSON.stringify({
      event: "telegram.youtube_request.failure",
      errorCategory: category,
      message: safeErrorMessage(error),
    }));

    if (category === ERROR_CATEGORIES.NO_CAPTIONS) {
      await safeSendMessage(env, chatId, "❌ برای این ویدیو زیرنویس قابل استخراج پیدا نشد.");
    } else if (category === ERROR_CATEGORIES.VIDEO_UNAVAILABLE) {
      await safeSendMessage(env, chatId, "❌ این ویدیو خصوصی یا در دسترس نیست.");
    } else if (category === ERROR_CATEGORIES.BOT_DETECTION) {
      await safeSendMessage(env, chatId, "⚠️ یوتیوب فعلاً اجازه استخراج متن این ویدیو را نمی‌دهد. لطفاً چند دقیقه بعد دوباره امتحان کنید.");
    } else if (category === ERROR_CATEGORIES.TRANSCRIPT_TOO_LARGE) {
      await safeSendMessage(env, chatId, "⚠️ متن این ویدیو برای ارسال بیش از حد بزرگ است.");
    } else {
      await safeSendMessage(env, chatId, "⚠️ در دریافت متن ویدیو مشکلی پیش آمد. لطفاً چند لحظه بعد دوباره امتحان کنید.");
    }
  }
}

export function extractVideoId(input) {
  const candidate = input.match(/https?:\/\/[^\s<>]+/i)?.[0] ?? input;
  let url;
  try { url = new URL(candidate); } catch { return null; }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let id = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (["youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else if (url.pathname.startsWith("/shorts/")) id = url.pathname.split("/")[2] ?? null;
  }
  return id && YOUTUBE_ID_RE.test(id) ? id : null;
}

export async function getYouTubeTranscript(videoId, env = {}, fetchImpl = fetch) {
  logEvent("youtube.transcript.start", { videoId });
  let selectedClient = null;

  try {
    const source = await findCaptionTracks(videoId, env, fetchImpl);
    selectedClient = source.client.name;
    const orderedTracks = rankCaptionTracks(source.tracks, source.renderer);
    let sawBotDetection = false;
    let sawUpstreamFailure = false;
    let sawParseFailure = false;

    for (const track of orderedTracks) {
      logEvent("youtube.caption_track.selected", {
        videoId,
        client: source.client.name,
        languageCode: track.languageCode ?? null,
        autoGenerated: track.kind === "asr",
      });

      const result = await downloadCaptionTrack(track, videoId, source.client, fetchImpl);
      if (result.text) {
        logEvent("youtube.transcript.success", {
          videoId,
          client: source.client.name,
          languageCode: track.languageCode ?? null,
          autoGenerated: track.kind === "asr",
          characterCount: result.text.length,
        });
        return {
          title: source.title || "YouTube Transcript",
          text: result.text,
          languageCode: track.languageCode,
          autoGenerated: track.kind === "asr",
        };
      }
      sawBotDetection ||= result.category === ERROR_CATEGORIES.BOT_DETECTION;
      sawUpstreamFailure ||= result.category === ERROR_CATEGORIES.UPSTREAM_ERROR;
      sawParseFailure ||= result.category === ERROR_CATEGORIES.PARSE_ERROR;
    }

    if (sawBotDetection) throw new YouTubeExtractionError(ERROR_CATEGORIES.BOT_DETECTION, "All caption download formats were blocked");
    if (sawUpstreamFailure) throw new YouTubeExtractionError(ERROR_CATEGORIES.UPSTREAM_ERROR, "All caption download formats failed upstream");
    if (sawParseFailure) throw new YouTubeExtractionError(ERROR_CATEGORIES.PARSE_ERROR, "All caption payloads were malformed");
    throw new YouTubeExtractionError(ERROR_CATEGORIES.NO_CAPTIONS, "Caption tracks contained no text");
  } catch (error) {
    const normalized = normalizeExtractionError(error);
    logEvent("youtube.transcript.failure", {
      videoId,
      client: selectedClient,
      errorCategory: normalized.category,
      message: safeErrorMessage(normalized),
    }, true);
    throw normalized;
  }
}

async function findCaptionTracks(videoId, env, fetchImpl) {
  const outcomes = [];
  const clients = getConfiguredClients(env);

  for (const client of clients.slice(0, 5)) {
    logEvent("youtube.innertube.client_attempt", { videoId, client: client.name });
    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, buildInnerTubeUrl(env), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": client.userAgent,
          "x-youtube-client-name": client.clientId,
          "x-youtube-client-version": client.clientVersion,
          origin: "https://www.youtube.com",
        },
        body: JSON.stringify(buildPlayerRequest(videoId, client)),
      }, 10_000);
    } catch (error) {
      outcomes.push({ category: ERROR_CATEGORIES.UPSTREAM_ERROR, client: client.name });
      logEvent("youtube.innertube.response", {
        videoId,
        client: client.name,
        httpStatus: null,
        errorCategory: ERROR_CATEGORIES.UPSTREAM_ERROR,
        message: safeErrorMessage(error),
      }, true);
      continue;
    }

    const body = await response.text();
    if (isBotDetection(body)) {
      outcomes.push({ category: ERROR_CATEGORIES.BOT_DETECTION, client: client.name, status: response.status });
      logEvent("youtube.innertube.response", {
        videoId,
        client: client.name,
        httpStatus: response.status,
        errorCategory: ERROR_CATEGORIES.BOT_DETECTION,
      }, true);
      continue;
    }

    if (!response.ok) {
      const category = response.status === 429 || response.status === 403
        ? ERROR_CATEGORIES.BOT_DETECTION
        : ERROR_CATEGORIES.UPSTREAM_ERROR;
      outcomes.push({ category, client: client.name, status: response.status });
      logEvent("youtube.innertube.response", {
        videoId,
        client: client.name,
        httpStatus: response.status,
        errorCategory: category,
      }, true);
      continue;
    }

    let player;
    try {
      player = JSON.parse(body);
    } catch {
      outcomes.push({ category: ERROR_CATEGORIES.PARSE_ERROR, client: client.name, status: response.status });
      logEvent("youtube.innertube.response", {
        videoId,
        client: client.name,
        httpStatus: response.status,
        errorCategory: ERROR_CATEGORIES.PARSE_ERROR,
      }, true);
      continue;
    }

    const statusResult = classifyPlayability(player.playabilityStatus);
    const renderer = player.captions?.playerCaptionsTracklistRenderer;
    const tracks = Array.isArray(renderer?.captionTracks) ? renderer.captionTracks.filter((track) => track?.baseUrl) : [];

    logEvent("youtube.innertube.response", {
      videoId,
      client: client.name,
      httpStatus: response.status,
      playabilityStatus: player.playabilityStatus?.status ?? null,
      errorCategory: statusResult.category,
    }, Boolean(statusResult.category));

    if (tracks.length) {
      logEvent("youtube.caption_tracks.found", {
        videoId,
        client: client.name,
        httpStatus: response.status,
        trackCount: tracks.length,
      });
      return { client, tracks, renderer, title: player.videoDetails?.title || "YouTube Transcript" };
    }

    outcomes.push({
      category: statusResult.category || ERROR_CATEGORIES.NO_CAPTIONS,
      client: client.name,
      status: response.status,
      reason: statusResult.reason,
    });
  }

  throw classifyAggregateFailure(outcomes);
}

export function buildPlayerRequest(videoId, client) {
  return {
    context: {
      client: {
        clientName: client.clientName,
        clientVersion: client.clientVersion,
        hl: "en",
        gl: "US",
        ...client.extra,
      },
      user: { lockedSafetyMode: false },
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: { contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" } },
  };
}

function buildInnerTubeUrl(env) {
  const url = new URL("https://www.youtube.com/youtubei/v1/player");
  url.searchParams.set("prettyPrint", "false");
  if (env.YOUTUBE_INNERTUBE_API_KEY) url.searchParams.set("key", env.YOUTUBE_INNERTUBE_API_KEY);
  return url.toString();
}

function getConfiguredClients(env) {
  if (!env.YOUTUBE_CLIENTS_JSON) return YOUTUBE_CLIENTS;
  try {
    const parsed = JSON.parse(env.YOUTUBE_CLIENTS_JSON);
    if (!Array.isArray(parsed) || !parsed.length) throw new Error("Expected a non-empty array");
    return parsed.map((client) => ({ ...client, extra: client.extra ?? {} }));
  } catch (error) {
    logEvent("youtube.clients_config.invalid", {
      errorCategory: ERROR_CATEGORIES.PARSE_ERROR,
      message: safeErrorMessage(error),
    }, true);
    return YOUTUBE_CLIENTS;
  }
}

export function classifyPlayability(playabilityStatus = {}) {
  const status = String(playabilityStatus?.status ?? "").toUpperCase();
  const reason = collectText(playabilityStatus).toLowerCase();
  if (isBotDetection(`${status} ${reason}`)) return { category: ERROR_CATEGORIES.BOT_DETECTION, reason };
  if (/private|deleted|removed|unavailable|not available|does not exist|uploader has closed/i.test(reason)) {
    return { category: ERROR_CATEGORIES.VIDEO_UNAVAILABLE, reason };
  }
  if (status && status !== "OK") return { category: ERROR_CATEGORIES.UPSTREAM_ERROR, reason: reason || status };
  return { category: null, reason };
}

function classifyAggregateFailure(outcomes) {
  if (!outcomes.length) return new YouTubeExtractionError(ERROR_CATEGORIES.UPSTREAM_ERROR, "No InnerTube clients were attempted");
  const categories = outcomes.map((outcome) => outcome.category);
  if (categories.includes(ERROR_CATEGORIES.VIDEO_UNAVAILABLE)) {
    return new YouTubeExtractionError(ERROR_CATEGORIES.VIDEO_UNAVAILABLE, "Video is private, deleted, or unavailable");
  }
  if (categories.includes(ERROR_CATEGORIES.NO_CAPTIONS)) {
    return new YouTubeExtractionError(ERROR_CATEGORIES.NO_CAPTIONS, "No caption tracks found after all clients");
  }
  if (categories.includes(ERROR_CATEGORIES.BOT_DETECTION)) {
    return new YouTubeExtractionError(ERROR_CATEGORIES.BOT_DETECTION, "All usable InnerTube clients were blocked");
  }
  if (categories.every((category) => category === ERROR_CATEGORIES.PARSE_ERROR)) {
    return new YouTubeExtractionError(ERROR_CATEGORIES.PARSE_ERROR, "All InnerTube responses were malformed");
  }
  return new YouTubeExtractionError(ERROR_CATEGORIES.UPSTREAM_ERROR, "All InnerTube clients failed");
}

export function rankCaptionTracks(tracks, renderer = {}) {
  const defaultIndexes = new Set(
    (renderer.audioTracks ?? [])
      .filter((audio) => audio?.hasDefaultTrack && Number.isInteger(audio.defaultCaptionTrackIndex))
      .map((audio) => audio.defaultCaptionTrackIndex),
  );

  return tracks
    .map((track, index) => ({ track, index }))
    .sort((a, b) => {
      const manualDifference = Number(a.track.kind === "asr") - Number(b.track.kind === "asr");
      if (manualDifference) return manualDifference;
      const defaultDifference = Number(!defaultIndexes.has(a.index)) - Number(!defaultIndexes.has(b.index));
      if (defaultDifference) return defaultDifference;
      const explicitDefault = Number(!a.track.isDefault) - Number(!b.track.isDefault);
      if (explicitDefault) return explicitDefault;
      return a.index - b.index;
    })
    .map(({ track }) => track);
}

async function downloadCaptionTrack(track, videoId, client, fetchImpl) {
  const formats = ["json3", "vtt", null];
  let lastCategory = null;

  for (const format of formats) {
    const url = withCaptionFormat(track.baseUrl, format);
    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, url, {
        headers: {
          "accept-language": "en-US,en;q=0.9",
          "user-agent": client.userAgent,
        },
      }, 10_000);
    } catch (error) {
      lastCategory = ERROR_CATEGORIES.UPSTREAM_ERROR;
      logEvent("youtube.caption_download.response", {
        videoId,
        client: client.name,
        format: format ?? "xml",
        httpStatus: null,
        errorCategory: lastCategory,
        message: safeErrorMessage(error),
      }, true);
      continue;
    }

    const raw = await response.text();
    if (isBotDetection(raw) || response.status === 403 || response.status === 429) {
      lastCategory = ERROR_CATEGORIES.BOT_DETECTION;
    } else if (!response.ok) {
      lastCategory = ERROR_CATEGORIES.UPSTREAM_ERROR;
    } else {
      try {
        const cues = parseCaptionPayload(raw, format);
        const text = cleanTranscript(cues);
        if (text) return { text, category: null };
        lastCategory = ERROR_CATEGORIES.NO_CAPTIONS;
      } catch {
        lastCategory = ERROR_CATEGORIES.PARSE_ERROR;
      }
    }

    logEvent("youtube.caption_download.response", {
      videoId,
      client: client.name,
      format: format ?? "xml",
      httpStatus: response.status,
      errorCategory: lastCategory,
    }, true);
  }

  return { text: "", category: lastCategory ?? ERROR_CATEGORIES.NO_CAPTIONS };
}

function withCaptionFormat(baseUrl, format) {
  const url = new URL(baseUrl);
  if (format) url.searchParams.set("fmt", format);
  else url.searchParams.delete("fmt");
  return url.toString();
}

export function parseCaptionPayload(raw, hintedFormat = null) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return [];

  if (hintedFormat === "json3" || trimmed.startsWith("{")) {
    const data = JSON.parse(trimmed);
    if (!Array.isArray(data.events)) throw new Error("Malformed JSON3 caption payload");
    return data.events
      .filter((event) => Array.isArray(event.segs))
      .map((event) => event.segs.map((segment) => segment.utf8 ?? "").join(""));
  }

  if (hintedFormat === "vtt" || /^WEBVTT\b/i.test(trimmed)) return parseWebVtt(trimmed);

  const cues = [];
  const pattern = /<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/gi;
  let match;
  while ((match = pattern.exec(trimmed))) cues.push(match[1]);
  if (!cues.length && /<transcript\b/i.test(trimmed)) return [];
  if (!cues.length) throw new Error("Unknown caption payload");
  return cues;
}

function parseWebVtt(vtt) {
  const cues = [];
  const blocks = vtt.replace(/^\uFEFF/, "").split(/\r?\n\r?\n+/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim());
    if (!lines.length || /^WEBVTT\b/i.test(lines[0]) || /^NOTE\b/i.test(lines[0])) continue;
    const timestampIndex = lines.findIndex((line) => /-->/.test(line));
    if (timestampIndex < 0) continue;
    const text = lines.slice(timestampIndex + 1).join(" ").trim();
    if (text) cues.push(text);
  }
  return cues;
}

export function cleanTranscript(cues) {
  const result = [];
  for (const rawCue of cues) {
    let cue = decodeHtml(String(rawCue))
      .replace(/<[^>]*>/g, " ")
      .replace(/(?:^|\s)\[?(?:(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\]?\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cue) continue;

    const previous = result.at(-1);
    if (previous === cue || (previous && previous.startsWith(cue))) continue;
    if (previous && cue.startsWith(`${previous} `)) cue = cue.slice(previous.length).trim();
    if (previous) cue = removeWordOverlap(previous, cue);
    if (cue && cue !== result.at(-1)) result.push(cue);
  }
  return result.join("\n\n").trim();
}

function removeWordOverlap(previous, current) {
  const a = previous.split(" ");
  const b = current.split(" ");
  for (let size = Math.min(a.length, b.length, 12); size >= 2; size--) {
    if (a.slice(-size).join(" ") === b.slice(0, size).join(" ")) return b.slice(size).join(" ");
  }
  return current;
}

function decodeHtml(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? whole;
    const hex = entity[1].toLowerCase() === "x";
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}

export function sanitizeFilename(title) {
  const safe = String(title || "YouTube Transcript")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return `${safe || "YouTube Transcript"}.txt`;
}

export function isBotDetection(value) {
  const text = String(value ?? "").toLowerCase().replace(/[’‘]/g, "'");
  return [
    "sign in to confirm you're not a bot",
    "confirm you're not a bot",
    "confirm you are not a bot",
    "login_required",
    "login required",
    "request blocked",
    "ip blocked",
  ].some((needle) => text.includes(needle));
}

function collectText(value, depth = 0) {
  if (depth > 8 || value == null) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  if (Array.isArray(value)) return value.map((item) => collectText(item, depth + 1)).join(" ");
  if (typeof value === "object") return Object.values(value).map((item) => collectText(item, depth + 1)).join(" ");
  return "";
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("YouTube request timed out"), timeoutMs);
  try { return await fetchImpl(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function normalizeExtractionError(error) {
  if (error instanceof YouTubeExtractionError) return error;
  return new YouTubeExtractionError(ERROR_CATEGORIES.UPSTREAM_ERROR, safeErrorMessage(error));
}

function safeErrorMessage(error) {
  return String(error?.message ?? error ?? "Unknown error")
    .replace(/([?&](?:key|token|api_key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]")
    .replace(/(authorization\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

function logEvent(event, fields = {}, asError = false) {
  const output = JSON.stringify({ event, ...fields });
  if (asError) console.error(output);
  else console.log(output);
}

async function telegram(env, method, body, headers = undefined) {
  const response = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers, body });
  if (!response.ok) throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram ${method} rejected the request`);
  return result;
}

function sendMessage(env, chatId, text) {
  return telegram(env, "sendMessage", JSON.stringify({ chat_id: chatId, text }), { "content-type": "application/json" });
}

async function sendDocument(env, chatId, bytes, filename) {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("document", new Blob([bytes], { type: "text/plain;charset=utf-8" }), filename);
  return telegram(env, "sendDocument", form);
}

async function safeSendMessage(env, chatId, text) {
  try { await sendMessage(env, chatId, text); }
  catch (error) { console.error("Could not send error message", safeErrorMessage(error)); }
}

async function consumeRateLimit(chatId, env) {
  const max = positiveInt(env.RATE_LIMIT_MAX, 3);
  const windowSeconds = positiveInt(env.RATE_LIMIT_WINDOW_SECONDS, 60);
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(chatId)));
    const key = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const request = new Request("https:" + "//worker-rate-limit.invalid/" + key);
    const cached = await caches.default.match(request);
    const count = cached ? Number(await cached.text()) : 0;
    if (count >= max) return false;
    await caches.default.put(request, new Response(String(count + 1), {
      headers: { "cache-control": `public, max-age=${windowSeconds}` },
    }));
  } catch (error) {
    console.warn("Rate limiter unavailable", safeErrorMessage(error));
  }
  return true;
}

async function isDuplicateUpdate(updateId) {
  if (!Number.isInteger(updateId)) return false;
  try {
    const request = new Request("https:" + "//worker-update-id.invalid/" + updateId);
    if (await caches.default.match(request)) return true;
    await caches.default.put(request, new Response("1", { headers: { "cache-control": "public, max-age=86400" } }));
  } catch (error) {
    console.warn("Update deduplication unavailable", safeErrorMessage(error));
  }
  return false;
}

function positiveInt(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
