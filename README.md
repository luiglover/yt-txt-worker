# ربات تلگرام استخراج متن YouTube روی Cloudflare Workers

این پروژه یک Worker کاملاً serverless است: بدون VPS، Docker، Browser، Chrome، Selenium، Puppeteer، Python یا `yt-dlp`.

## روش استخراج

Worker صفحه عمومی ویدیو را با `fetch` دریافت می‌کند، داده `ytInitialPlayerResponse` را از HTML می‌خواند و فهرست `captionTracks` را استخراج می‌کند. سپس endpoint زیرنویس خود YouTube با فرمت `json3` فراخوانی می‌شود. ترک‌های دستی همیشه قبل از ترک‌های `kind=asr` (زیرنویس خودکار) امتحان می‌شوند. اگر JSON در دسترس نباشد، parser ساده XML نیز وجود دارد.

این روش هیچ API key پولی و هیچ runtime خارج از Web APIs استاندارد Workers ندارد. چون endpoint زیرنویس YouTube عمومی اما رسمی و پایدارِ قراردادی نیست، تغییرات یا محدودسازی IP از سمت YouTube می‌تواند در آینده نیازمند به‌روزرسانی parser باشد.

## امکانات

- `POST /webhook` برای Telegram webhook
- `GET /` برای health check
- پشتیبانی از `youtube.com/watch?v=...`، `youtu.be/...` و `youtube.com/shorts/...`
- اولویت manual subtitle و سپس auto-generated caption
- حذف timestamp، markup، فاصله اضافی، تکرار و overlap کپشن‌های rolling
- تولید و ارسال TXT در حافظه با `Blob` و `FormData`
- بدون filesystem و بدون ذخیره دائمی اطلاعات کاربران
- rate limit پایه و best-effort با Cache API؛ شناسه chat پیش از cache شدن SHA-256 می‌شود
- deduplication موقت Telegram updateها با Cache API
- پشتیبانی اختیاری از secret header وب‌هوک

## نصب و تست

```bash
npm install
npm test
```

## اجرای محلی

فایل `.dev.vars` بسازید؛ این فایل در `.gitignore` است:

```dotenv
TELEGRAM_BOT_TOKEN=123456:replace_me
# اختیاری:
TELEGRAM_WEBHOOK_SECRET=a-long-random-secret
```

سپس:

```bash
npm run dev
```

## Deploy

```bash
npx wrangler login
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler deploy
```

تنظیمات پیش‌فرض rate limit در `wrangler.toml` برابر ۳ درخواست در ۶۰ ثانیه برای هر chat است. برای احراز هویت قوی‌تر webhook، secret اختیاری را نیز ثبت کنید:

```bash
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

## تنظیم Telegram webhook

بدون secret اختیاری:

```bash
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "content-type: application/json" \
  -d '{"url":"https://YOUR-WORKER.workers.dev/webhook","allowed_updates":["message"]}'
```

با secret اختیاری:

```bash
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "content-type: application/json" \
  -d '{"url":"https://YOUR-WORKER.workers.dev/webhook","secret_token":"YOUR_SECRET","allowed_updates":["message"]}'
```

بررسی:

```bash
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
curl -sS "https://YOUR-WORKER.workers.dev/"
```

## متغیرها

| نام | لازم | پیش‌فرض | توضیح |
|---|---:|---:|---|
| `TELEGRAM_BOT_TOKEN` | بله | — | Secret توکن ربات |
| `TELEGRAM_WEBHOOK_SECRET` | خیر | — | بررسی هدر امنیتی Telegram |
| `RATE_LIMIT_MAX` | خیر | `3` | حداکثر درخواست در پنجره |
| `RATE_LIMIT_WINDOW_SECONDS` | خیر | `60` | طول پنجره rate limit |

## ماتریس تست

تست‌های خودکار شامل parse هر سه نوع URL، URL جعلی، اولویت manual، fallback به ASR، نبود subtitle، private/deleted، خطای موقت، متن طولانی و اجرای همزمان است. تست زنده YouTube و Telegram باید بعد از Deploy با ویدیوهای منتخب شما انجام شود؛ fixture عمومی ویدیوها ممکن است حذف یا تغییر کند و برای unit test قابل اتکا نیست.

## نکات عملیاتی

- فایل TXT روی دیسک نوشته نمی‌شود؛ فقط `Uint8Array`/`Blob` در حافظه ساخته می‌شود.
- سقف ایمنی فایل ۴۵ MiB است تا پایین‌تر از محدودیت‌های رایج ارسال Telegram بماند.
- Cache API اتمیک و global rate limiter نیست؛ برای نسخه اول abuse سبک مناسب است. برای محدودسازی سخت در چند PoP باید Durable Object یا KV اضافه شود.
- هیچ ورودی کاربر به shell یا subprocess فرستاده نمی‌شود؛ پروژه اصلاً subprocess ندارد.
- خطای فنی فقط با `console.error` در log ثبت می‌شود و پیام عمومی فارسی برای کاربر ارسال می‌گردد.
