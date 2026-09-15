const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const TELEGRAM_API = "https://api.telegram.org";
const START_TEXT = "لینک ویدیوی YouTube را ارسال کنید تا متن آن استخراج و به صورت فایل TXT برای شما ارسال شود.";

class NoTranscriptError extends Error {}
class VideoUnavailableError extends Error {}
class TemporaryError extends Error {}

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
        if (supplied !== env.TELEGRAM_WEBHOOK_SECRET) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      if (await isDuplicateUpdate(update.update_id)) {
        return new Response("OK");
      }

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

    const allowed = await consumeRateLimit(chatId, env);
    if (!allowed) {
      await sendMessage(env, chatId, "⚠️ تعداد درخواست‌ها زیاد است. لطفاً کمی بعد دوباره امتحان کنید.");
      return;
    }

    await sendMessage(env, chatId, "⏳ در حال استخراج متن ویدیو...");
    const { title, text: transcript } = await getYouTubeTranscript(videoId);
    const bytes = new TextEncoder().encode(transcript);

    // Keep a safety margin below Telegram's commonly supported Bot API upload limit.
    if (bytes.byteLength > 45 * 1024 * 1024) {
      throw new TemporaryError("Transcript exceeds upload safety limit");
    }

    await sendDocument(env, chatId, bytes, sanitizeFilename(title));
    await sendMessage(env, chatId, "✅ متن ویدیو آماده شد.");
  } catch (error) {
    console.error("Bot processing error", {
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
    });

    if (error instanceof NoTranscriptError) {
      await safeSendMessage(env, chatId, "❌ برای این ویدیو متن یا زیرنویس قابل دریافت پیدا نشد.");
    } else if (error instanceof VideoUnavailableError) {
      await safeSendMessage(env, chatId, "❌ این ویدیو قابل دسترسی نیست.");
    } else {
      await safeSendMessage(env, chatId, "⚠️ در دریافت متن ویدیو مشکلی پیش آمد. لطفاً چند لحظه بعد دوباره امتحان کنید.");
    }
  }
}

export function extractVideoId(input) {
  const candidate = input.match(/https?:\/\/[^\s<>]+/i)?.[0] ?? input;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let id = null;

  if (host === "youtu.be") {
    id = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else if (url.pathname.startsWith("/shorts/")) id = url.pathname.split("/")[2] ?? null;
  }

  return id && YOUTUBE_ID_RE.test(id) ? id : null;
}

export async function getYouTubeTranscript(videoId, fetchImpl = fetch) {
  const watchUrl = "https:" + "//www.youtube.com/watch?v=" + encodeURIComponent(videoId) + "&hl=en";
  let response;
  try {
    response = await fetchImpl(watchUrl, {
      headers: {
        "accept-language": "en-US,en;q=0.9",
        "user-agent": "Mozilla/5.0 (compatible; CloudflareWorker/1.0)",
      },
      redirect: "follow",
    });
  } catch (cause) {
    throw new TemporaryError("YouTube watch request failed", { cause });
  }

  if (!response.ok) {
    if (response.status === 404 || response.status === 410) throw new VideoUnavailableError("Video not found");
    throw new TemporaryError(`YouTube returned HTTP ${response.status}`);
  }

  const html = await response.text();
  const player = parsePlayerResponse(html);
  if (!player) throw new TemporaryError("ytInitialPlayerResponse was not found");

  const status = player.playabilityStatus?.status;
  if (status && status !== "OK") {
    const reason = `${player.playabilityStatus?.reason ?? ""} ${player.playabilityStatus?.errorScreen?.playerErrorMessageRenderer?.reason?.simpleText ?? ""}`;
    if (/private|removed|deleted|unavailable|not available|does not exist/i.test(reason) || ["ERROR", "LOGIN_REQUIRED"].includes(status)) {
      throw new VideoUnavailableError(reason || status);
    }
    throw new TemporaryError(reason || status);
  }

  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (!tracks.length) throw new NoTranscriptError("No caption tracks");

  const ordered = chooseCaptionTracks(tracks);
  let lastError;
  let hadReadableResponse = false;
  for (const track of ordered) {
    try {
      const transcriptResponse = await fetchImpl(withFormat(track.baseUrl, "json3"), {
        headers: { "accept-language": "en-US,en;q=0.9" },
      });
      if (!transcriptResponse.ok) {
        lastError = new Error(`Caption HTTP ${transcriptResponse.status}`);
        continue;
      }
      hadReadableResponse = true;
      const raw = await transcriptResponse.text();
      const cues = parseCaptionPayload(raw);
      const cleaned = cleanTranscript(cues);
      if (cleaned) {
        return { title: player.videoDetails?.title ?? "", text: cleaned, languageCode: track.languageCode, autoGenerated: track.kind === "asr" };
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (!hadReadableResponse && lastError) {
    throw new TemporaryError("All caption track requests failed", { cause: lastError });
  }
  throw new NoTranscriptError("Caption tracks had no readable content");
}

export function parsePlayerResponse(html) {
  for (const marker of ["ytInitialPlayerResponse", '"playerResponse"']) {
    const markerIndex = html.indexOf(marker);
    if (markerIndex < 0) continue;
    const start = html.indexOf("{", markerIndex + marker.length);
    if (start < 0) continue;
    const json = readBalancedJson(html, start);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json);
      if (marker === '"playerResponse"' && typeof parsed === "string") return JSON.parse(parsed);
      return parsed;
    } catch {
      // Continue to the next representation.
    }
  }
  return null;
}

function readBalancedJson(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

export function chooseCaptionTracks(tracks) {
  return [...tracks].sort((a, b) => Number(a.kind === "asr") - Number(b.kind === "asr"));
}

function withFormat(baseUrl, format) {
  const url = new URL(baseUrl);
  url.searchParams.set("fmt", format);
  return url.toString();
}

export function parseCaptionPayload(raw) {
  try {
    const data = JSON.parse(raw);
    return (data.events ?? [])
      .filter((event) => Array.isArray(event.segs))
      .map((event) => event.segs.map((segment) => segment.utf8 ?? "").join(""));
  } catch {
    const cues = [];
    const pattern = /<text\b[^>]*>([\s\S]*?)<\/text>/gi;
    let match;
    while ((match = pattern.exec(raw))) cues.push(match[1]);
    return cues;
  }
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
  const max = Math.min(a.length, b.length, 12);
  for (let size = max; size >= 2; size--) {
    if (a.slice(-size).join(" ") === b.slice(0, size).join(" ")) return b.slice(size).join(" ");
  }
  return current;
}

function decodeHtml(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? _;
    const hex = entity[1].toLowerCase() === "x";
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  });
}

export function sanitizeFilename(title) {
  const safe = String(title || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return `${safe || "youtube_transcript"}.txt`;
}

async function telegram(env, method, body, headers = undefined) {
  const response = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers,
    body,
  });
  if (!response.ok) throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram ${method} rejected the request`);
  return result;
}

function sendMessage(env, chatId, text) {
  return telegram(env, "sendMessage", JSON.stringify({ chat_id: chatId, text }), {
    "content-type": "application/json",
  });
}

async function sendDocument(env, chatId, bytes, filename) {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("document", new Blob([bytes], { type: "text/plain;charset=utf-8" }), filename);
  return telegram(env, "sendDocument", form);
}

async function safeSendMessage(env, chatId, text) {
  try { await sendMessage(env, chatId, text); } catch (error) { console.error("Could not send error message", error); }
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
    // Cache API is best-effort and may be absent in local tests.
    console.warn("Rate limiter unavailable", error?.message);
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
    console.warn("Update deduplication unavailable", error?.message);
  }
  return false;
}

function positiveInt(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
