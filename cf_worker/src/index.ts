/**
 * Cloudflare Worker — Telegram webhook for crypto-rsi-alert.
 *
 * Flow:
 *   Telegram callback_query → verify secret → dedupe (KV TTL) →
 *   answerCallbackQuery (toast <1s) → GitHub repository_dispatch.
 *
 * Replaces the polling cron handler. Watchlist edits still happen
 * inside the `add-ticker` workflow, preserving Python suggest logic.
 */

export interface Env {
  DEDUPE: KVNamespace;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  DEDUPE_TTL_SECONDS: string;
  CHAT_ID: string;
  DASH_TOKEN: string; // token เฉพาะ dashboard endpoints (/health, /divwatch) — แยกจาก WEBHOOK_SECRET ของ Telegram
}

interface InlineButton {
  text: string;
  callback_data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      chat?: { id: number };
      message_id?: number;
      text?: string;
      reply_markup?: { inline_keyboard?: InlineButton[][] };
    };
  };
}

const SYMBOL_RE = /^[A-Z0-9_]{2,20}$/;

// ---- 15m bearish-divergence watcher (fade-the-top) ----
// รันทุก 15 นาที offset (:02/:17/:32/:47) เลี่ยงชนนาที workflow เดิม
// เริ่มจาก SYN ตัวเดียว — ขยายเป็น watchlist ทีหลังได้
// source: ทุกตัวใช้ gate futures (api.gateio.ws) — api-gcp.binance.com โดน 451 จาก CF edge แล้ว
// (2026-06-26: binance ทั้ง 6 ตัวโดน geo-block ผ่าน api-gcp ซ้ำรอย 403/451 → ย้ายมา gate ที่ edge ดึงได้ชัวร์)
// code ยังรองรับ source "binance" ไว้ (fetchKlines) เผื่อกลับมาใช้ได้ภายหลัง
// source: gate = futures (มี funding, ใช้เป็นหลัก) | gate_spot = spot (เหรียญที่ futures delisted เช่น SYN) | binance = สำรอง (edge 451 อยู่)
type DivSym = { symbol: string; source: "binance" | "gate" | "gate_spot"; label: string };
const DIVWATCH_KEY = "divwatch:list"; // single source of truth ใน KV — แก้ผ่าน dashboard (POST /divwatch); default = seed ครั้งแรก
const DIV_WATCH_DEFAULT: DivSym[] = [
  { symbol: "SYN_USDT", source: "gate", label: "SYN" },
  { symbol: "BEL_USDT", source: "gate", label: "BEL" },
  { symbol: "MMT_USDT", source: "gate", label: "MMT" },
  { symbol: "DEXE_USDT", source: "gate", label: "DEXE" },
  { symbol: "AWE_USDT", source: "gate", label: "AWE" },
  { symbol: "G_USDT", source: "gate", label: "G" },
  { symbol: "FOLKS_USDT", source: "gate", label: "FOLKS" },
  { symbol: "BAS_USDT", source: "gate", label: "BAS" },
  { symbol: "TAC_USDT", source: "gate", label: "TAC" },
];

// อ่าน DIV_WATCH จาก KV (seed default ถ้ายังไม่มี) — worker + dashboard ใช้ list เดียวกัน
async function getDivWatch(env: Env): Promise<DivSym[]> {
  const raw = await env.DEDUPE.get(DIVWATCH_KEY);
  if (raw) {
    try { const a = JSON.parse(raw); if (Array.isArray(a) && a.length) return a as DivSym[]; } catch { /* fall through to seed */ }
  }
  await env.DEDUPE.put(DIVWATCH_KEY, JSON.stringify(DIV_WATCH_DEFAULT));
  return DIV_WATCH_DEFAULT;
}
const DIV_MINUTES = [2, 17, 32, 47];
const DIV_PIVOT_K = 2; // แท่งซ้าย/ขวาที่ต้องต่ำกว่า ถึงนับเป็น swing high (ยืนยันแล้ว = closed)
const DIV_LOOKBACK_BARS = 48; // 12 ชม. — เทียบนิวไฮกับยอดสูงสุดใน window นี้ (ไม่ใช่แค่ยอดติดกัน)
const DIV_RSI_MIN = 65; // swing high ก่อนหน้าต้อง RSI สูงพอ — กรองให้เป็น fade-the-top context
const DIV_DEDUPE_TTL = 6 * 3600; // alert ต่อ 1 setup ครั้งเดียว (คีย์ด้วย ts ของ high ที่สอง)
const DIV_FRESH_BARS = 4; // p2 ต้องอยู่ภายใน N แท่งล่าสุด (~1 ชม.) — กัน stale alert หลัง downtime
// ---- flip detection (mirror): bullish divergence ที่ "ก้น" หลัง bearish div ยิงไปแล้ว ----
const DIV_RSI_MAX_LOW = 35; // trough ก่อนหน้าต้อง oversold พอ (mirror ของ DIV_RSI_MIN)
const FLIP_WATCH_TTL = 24 * 3600; // หลัง bearish div เปิด flip-watch นาน N — พ้นแล้วเลิกเฝ้า
// ---- 2-stage entry confirm: หลัง bearish div = "arm" → รอ sweep+reclaim ค่อยส่ง entry จริง (กันโดนกระชาก/liquidate) ----
// PROTOTYPE: threshold ตั้งต้นจากเหตุผล ยังไม่ได้ calibrate จากข้อมูลจริง (instrument ทีหลังเพื่อจูน)
const CONFIRM_WATCH_TTL = 12 * 3600; // arm รอ confirm ได้ 12 ชม. — เกินนี้ setup หมดอายุ
const CONFIRM_DEDUPE_TTL = 6 * 3600; // entry alert ต่อ 1 setup ครั้งเดียว
const CONFIRM_STOP_ATR = 0.5; // stop = peakHigh + 0.5×ATR(15m) — เหนือ wick กระชาก
const CONFIRM_PEAK_BARS = 4; // อัปเดต peak/sweep จาก N แท่งล่าสุด (กัน tick หายแล้วพลาดยอด)
const CONFIRM_RECENT_TTL = 2 * 3600; // โชว์ "confirmed" บน dashboard นาน N หลังเข้า (lastconfirm marker)
// ---- RSI×MA cross watcher: RSI ตัดลงใต้ RSI-based MA (SMA14 ของ RSI, ตรง default TradingView) บน 1h/2h ----
// ส่งเฉพาะตัดลงจากโซนสูง (MA ≥ CROSS_MA_MIN) — จุดตัดใน sideways เกิดถี่มาก ไม่กรอง = spam
const CROSS_TFS = ["1h", "2h"] as const;
const CROSS_MA_PERIOD = 14;
const CROSS_MA_MIN = 60;
const CROSS_MINUTE = 2; // เช็คที่ tick :02 — แท่ง 1h/2h เพิ่งปิด (แท่ง 2h ปิดชั่วโมงคู่ dedupe จัดการเอง)
const CROSS_DEDUPE_TTL = 24 * 3600; // ครั้งเดียวต่อจุดตัด (คีย์ด้วย ts แท่งที่ตัด)
// confluence: bearish div (15m) เกิดภายใน N → 2h cross อัปเกรดเป็น 🎯 CONFIRMED (div ทดแทน zone filter ได้
// เพราะ div คือหลักฐาน "ยอดร้อน" ตรงกว่า MA≥60 ที่เป็นแค่ proxy กัน spam)
const CROSS_CONFIRM_TF = "2h";
const LASTDIV_TTL = 24 * 3600; // marker `lastdiv:{symbol}` อายุเท่า flip-watch — เก่ากว่านี้ถือว่าคนละรอบ
// CF Worker edge ดึง data-api.binance.vision / api.binance.com ไม่ได้ (403 bot-protect, probe 2026-06-23)
// api-gcp.binance.com เข้าได้จาก edge แต่ต้องใช้ browser UA
const KLINES_BASE = "https://api-gcp.binance.com";
const KLINES_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// ---- observability: health record + fail-alert + daily heartbeat (กัน watcher fail เงียบเหมือนเคส 403) ----
const DIV_HEALTH_KEY = "health:div";
const DIV_HEALTH_TTL = 6 * 3600; // health record สด 6 ชม. — หาย/เก่ากว่านี้ = watcher ไม่ได้ tick
const DIV_FAIL_ALERT_AFTER = 2; // เตือนเมื่อ fetch fail ติดกัน N tick (กัน network blip ครั้งเดียว)
const DIV_FAIL_DEDUPE_TTL = 3 * 3600; // เตือน fail ซ้ำเหรียญเดิมไม่เกิน 1 ครั้ง/3 ชม.
// สถานะที่นับเป็น "ดึงข้อมูลไม่ได้" — fade-the-top จะตาบอดเหรียญนั้น (เทียบเคส 403 ที่ fail เงียบทุก tick)
const FETCH_ERROR_STATUSES = new Set(["klines_http_error", "too_few_klines", "exception"]);
type DivHealth = { ts: number; symbols: Record<string, { status: string; code?: number; fails: number }> };

// ---- Scheduled triggers: Worker เป็นนาฬิกาแทน GitHub cron (โดน throttle 1-3 ชม.) ----
// จับคู่ด้วย "เวลา tick" ไม่ใช่ cron string — Cloudflare อาจ normalize string จน map ตรง ๆ พลาด
// เวลาไทย = UTC+7: 00:10 → 07:10 refresh, 00:20 → 07:20 reversal+tracker, :23 ทุก 4 ชม. → rsi+watchlist
function workflowsForTick(scheduledTime: number): string[] {
  const d = new Date(scheduledTime);
  const m = d.getUTCMinutes();
  const h = d.getUTCHours();
  if (m === 30 && h === 0 && d.getUTCDay() === 1) return ["weekly-summary.yml"];
  if (m === 10 && h === 0) return ["refresh-levels.yml"];
  if (m === 20 && h === 0) return ["reversal-alert.yml"];
  if (m === 23 && h % 4 === 0) return ["rsi-alert.yml", "watchlist.yml"];
  return [];
}

async function dispatchWorkflow(env: Env, workflowFile: string): Promise<void> {
  const r = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "crypto-rsi-webhook",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );
  console.log(`dispatch ${workflowFile}: ${r.status}`);
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const files = workflowsForTick(event.scheduledTime);
    console.log(`cron tick ${event.cron} @ ${new Date(event.scheduledTime).toISOString()} -> ${files.join(", ") || "(no mapping)"}`);
    const tasks: Promise<void>[] = files.map((f) => dispatchWorkflow(env, f));
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    if (DIV_MINUTES.includes(minute)) {
      tasks.push(runDivergenceWatch(env));
    }
    if (minute === CROSS_MINUTE) {
      tasks.push(runRsiMaCrossWatch(env));
    }
    ctx.waitUntil(Promise.all(tasks));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "GET") {
      // GET /health?token=<WEBHOOK_SECRET> — สถานะ watcher ล่าสุด (แทน temp debug route + wrangler tail ที่ไม่นิ่ง)
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        if (url.searchParams.get("token") !== env.DASH_TOKEN) {
          return new Response("forbidden", { status: 403 });
        }
        const h = await readDivHealth(env);
        const list = await getDivWatch(env);
        const confirm = await readConfirmStates(env, list); // lifecycle armed/swept/confirmed ต่อเหรียญ — ให้ dashboard โชว์
        // อายุ (นาที) ของ bearish div ล่าสุดต่อเหรียญ — dashboard ใช้โชว์ confluence กับ 2h cross
        const lastdiv: Record<string, number> = {};
        for (const item of list) {
          const v = await env.DEDUPE.get(`lastdiv:${item.symbol}`);
          if (v) lastdiv[item.symbol] = Math.round((Date.now() - Number(v)) / 60000);
        }
        const body = h
          ? { ...h, iso: new Date(h.ts).toISOString(), ageMinutes: Math.round((Date.now() - h.ts) / 60000), divwatch: list, confirm, lastdiv }
          : { error: "no health record — watcher ไม่ได้ tick ภายใน TTL (อาจตายทั้งตัว)", divwatch: list, confirm, lastdiv };
        return new Response(JSON.stringify(body, null, 2), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/divmanage") return handleDivManage(env, url); // หน้าจัดการ div watch จาก remote (token-gated)
      if (url.pathname === "/coinstatus") return handleCoinStatus(env, url); // สถานะต่อเหรียญให้หน้า divmanage
      if (url.pathname === "/wlmanage") return handleWlManage(env, url); // หน้าจัดการ watchlist หลักจาก remote
      if (url.pathname === "/wl") return handleWl(env, url, "GET"); // list watchlist (JSON)
      // ops: ดู/ซ่อม webhook config — เคส 2026-07-02: allowed_updates เดิมมีแค่ callback_query
      // ทำให้คำสั่งพิมพ์ (/wl ฯลฯ) ไม่เคยถูกส่งมา; /fixwebhook ตั้งใหม่พร้อม secret เดิม (idempotent)
      if (url.pathname === "/webhookinfo") {
        if (url.searchParams.get("token") !== env.DASH_TOKEN) return new Response("forbidden", { status: 403 });
        const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`);
        return new Response(await r.text(), { headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/fixwebhook") {
        if (url.searchParams.get("token") !== env.DASH_TOKEN) return new Response("forbidden", { status: 403 });
        const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://crypto-rsi-webhook.kappaponpuesan.workers.dev",
            secret_token: env.WEBHOOK_SECRET,
            allowed_updates: ["message", "callback_query"],
          }),
        });
        return new Response(await r.text(), { headers: { "content-type": "application/json" } });
      }
      return new Response("ok", { status: 200 });
    }
    if (req.method === "POST") {
      const u = new URL(req.url);
      if (u.pathname === "/divwatch") return handleDivWatchMutate(env, u); // add/remove ticker จาก dashboard
      if (u.pathname === "/wl") return handleWl(env, u, "POST"); // add/remove ใน watchlist หลัก
    }
    if (req.method !== "POST") return new Response("ok", { status: 200 });

    const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secret !== env.WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    let update: TelegramUpdate;
    try {
      update = await req.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }

    // ---- คำสั่งพิมพ์ในแชท: /add SYM, /remove SYM, /wl — เฉพาะแชทของ user (CHAT_ID) ----
    const msg = update.message;
    if (msg?.text && String(msg.chat?.id ?? "") === env.CHAT_ID) {
      const m = msg.text.trim().match(/^\/(add|remove|rm|wl)(?:\s+(\S+))?$/i);
      if (m) {
        ctx.waitUntil(handleChatCommand(env, m[1].toLowerCase(), (m[2] || "").toUpperCase()));
        return new Response("command", { status: 200 });
      }
    }

    const cb = update.callback_query;
    if (!cb || !cb.data?.startsWith("add:")) {
      // ปุ่ม ✅ (noop) หรือ callback อื่น — ตอบเปล่าเพื่อหยุด loading spinner ฝั่ง Telegram
      if (cb) ctx.waitUntil(answerCallback(env, cb.id, ""));
      return new Response("ignored", { status: 200 });
    }

    const symbol = cb.data.slice(4).trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol)) {
      ctx.waitUntil(answerCallback(env, cb.id, "❌ Invalid symbol"));
      return new Response("bad symbol", { status: 200 });
    }

    // Cloudflare KV requires expirationTtl >= 60s — clamp to satisfy that floor.
    const ttl = Math.max(60, parseInt(env.DEDUPE_TTL_SECONDS, 10) || 60);
    const key = `recent:${symbol}`;
    const seen = await env.DEDUPE.get(key);

    if (seen) {
      ctx.waitUntil(
        answerCallback(env, cb.id, `⏭️ ${symbol} กำลังเพิ่มแล้ว`),
      );
      return new Response("dedupe", { status: 200 });
    }

    await env.DEDUPE.put(key, "1", { expirationTtl: ttl });

    ctx.waitUntil(
      Promise.all([
        answerCallback(env, cb.id, `✅ ${symbol} dispatched`),
        appendToMessage(env, cb, symbol),
        dispatchAddTicker(env, symbol),
      ]),
    );

    return new Response("ok", { status: 200 });
  },
};

async function answerCallback(
  env: Env,
  callbackId: string,
  text: string,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text }),
  });
}

async function appendToMessage(
  env: Env,
  cb: NonNullable<TelegramUpdate["callback_query"]>,
  symbol: string,
): Promise<void> {
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const original = cb.message?.text;
  if (!chatId || !messageId || original === undefined) return;

  // editMessageText ที่ไม่ส่ง reply_markup จะลบปุ่มทั้งแผง — ต้องส่ง keyboard เดิมกลับไป
  // โดยเปลี่ยนปุ่มที่เพิ่งกดเป็น ✅ (noop) ส่วนปุ่มอื่นคงไว้ให้กดต่อได้
  const keyboard = (cb.message?.reply_markup?.inline_keyboard ?? []).map((row) =>
    row.map((btn) =>
      btn.callback_data === `add:${symbol}`
        ? { text: `✅ ${symbol}`, callback_data: "noop" }
        : btn,
    ),
  );

  const appended = `${original}\n\n✅ <code>${symbol}</code> dispatched to GitHub`;
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: appended,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    }),
  });
}

// ---- Divergence watcher --------------------------------------------------

// Wilder RSI — ตรง build_features.wilder_rsi เป๊ะ: ewm(alpha=1/period, adjust=False)
// adjust=False ⇒ seed ที่ diff แรก (i=1); min_periods=period ⇒ NaN จนกว่าจะครบ period bars
function wilderRSI(closes: number[], period = 14): number[] {
  const n = closes.length;
  const rsi = new Array<number>(n).fill(NaN);
  if (n < period + 1) return rsi;
  const alpha = 1 / period;
  let avgG = NaN;
  let avgL = NaN;
  for (let i = 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    if (Number.isNaN(avgG)) {
      avgG = g;
      avgL = l;
    } else {
      avgG = (1 - alpha) * avgG + alpha * g;
      avgL = (1 - alpha) * avgL + alpha * l;
    }
    if (i >= period) rsi[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return rsi;
}

// swing high = high[i] สูงกว่า k แท่งทั้งสองข้างแบบ strict (ยืนยันแล้ว เพราะมี k แท่งขวา)
function swingHighs(highs: number[], k: number): number[] {
  const out: number[] = [];
  for (let i = k; i < highs.length - k; i++) {
    let ok = true;
    for (let j = 1; j <= k; j++) {
      if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

async function runDivergenceWatch(env: Env): Promise<void> {
  const prev = await readDivHealth(env);
  const list = await getDivWatch(env);
  const symbols: DivHealth["symbols"] = {};
  const crossed: { label: string; status: string; code?: number }[] = [];

  for (const item of list) {
    let status = "ok";
    let code: number | undefined;
    try {
      const r = await checkDivergence(env, item);
      status = String(r.status ?? "ok");
      if (typeof r.code === "number") code = r.code;
      console.log(`divergence ${item.label}: ${JSON.stringify(r)}`);
    } catch (e) {
      status = "exception";
      console.log(`divergence ${item.label} error: ${e}`);
    }
    // fail ติดกัน → นับสะสม; ok → reset (alert เฉพาะตอน "ข้าม" เกณฑ์พอดี เพื่อให้ส่งครั้งเดียว)
    const isErr = FETCH_ERROR_STATUSES.has(status);
    const fails = isErr ? (prev?.symbols[item.label]?.fails ?? 0) + 1 : 0;
    symbols[item.label] = code !== undefined ? { status, code, fails } : { status, fails };
    if (isErr && fails === DIV_FAIL_ALERT_AFTER) crossed.push({ label: item.label, status, code });
  }

  await writeDivHealth(env, { ts: Date.now(), symbols });

  // push: fetch fail ติดกันถึงเกณฑ์ → เตือนทันที (deduped) ไม่ปล่อย fail เงียบแบบเคส 403
  for (const f of crossed) {
    const dkey = `divfail:${f.label}:${f.status}${f.code ?? ""}`;
    if (await env.DEDUPE.get(dkey)) continue;
    const sent = await sendTelegram(
      env,
      `watcher-fail ${f.label}`,
      `⚠️ <b>15m watcher: ${f.label} ดึงข้อมูลไม่ได้</b>\n` +
        `status <code>${f.status}</code>${f.code ? ` (HTTP ${f.code})` : ""} — fail ${DIV_FAIL_ALERT_AFTER} tick ติดกัน\n` +
        `watcher อาจตาบอดเหรียญนี้ (เทียบเคส 403 ที่เคย fail เงียบ)`,
    );
    if (sent) await env.DEDUPE.put(dkey, "1", { expirationTtl: DIV_FAIL_DEDUPE_TTL });
  }

  await maybeHeartbeat(env, symbols);
}

// SMA ของ series ณ index i (NaN ถ้าค่าใน window ยังไม่ครบ/ไม่ valid)
function smaAt(vals: number[], i: number, period: number): number {
  if (i + 1 < period) return NaN;
  let s = 0;
  for (let j = i - period + 1; j <= i; j++) {
    if (Number.isNaN(vals[j])) return NaN;
    s += vals[j];
  }
  return s / period;
}

// สถานะ RSI(14) เทียบ RSI-based MA บนแท่งปิดล่าสุด — ใช้ทั้ง watcher และ /coinstatus
function crossState(closes: number[]): { rsi: number; ma: number; crossed: boolean; below: boolean; hot: boolean } | null {
  const i = closes.length - 1;
  const rsi = wilderRSI(closes, 14);
  const maPrev = smaAt(rsi, i - 1, CROSS_MA_PERIOD);
  const maNow = smaAt(rsi, i, CROSS_MA_PERIOD);
  if ([rsi[i - 1], rsi[i], maPrev, maNow].some(Number.isNaN)) return null;
  return {
    rsi: rsi[i], ma: maNow,
    crossed: rsi[i - 1] >= maPrev && rsi[i] < maNow,
    below: rsi[i] < maNow, hot: maPrev >= CROSS_MA_MIN,
  };
}

// RSI ตัดลงใต้ RSI-based MA จากโซนสูง บนแท่งปิดล่าสุด — เช็คเฉพาะแท่งล่าสุด = fresh เสมอ
async function runRsiMaCrossWatch(env: Env): Promise<void> {
  const list = await getDivWatch(env);
  for (const item of list) {
    for (const tf of CROSS_TFS) {
      try {
        const kl = await fetchKlines(item, tf);
        if ("error" in kl) {
          console.log(`rsicross ${item.label} ${tf}: ${kl.error}${kl.code ? ` ${kl.code}` : ""}`);
          continue;
        }
        const { closes, times } = kl;
        const i = closes.length - 1;
        const st = crossState(closes);
        if (!st) continue;
        if (!st.crossed) {
          console.log(`rsicross ${item.label} ${tf}: quiet rsi=${st.rsi.toFixed(1)} ma=${st.ma.toFixed(1)}`);
          continue;
        }
        // confluence: 2h cross + bearish div (15m) ภายใน 24 ชม. → 🎯 CONFIRMED; div ทดแทน zone filter
        const lastDiv = tf === CROSS_CONFIRM_TF ? await env.DEDUPE.get(`lastdiv:${item.symbol}`) : null;
        if (!lastDiv && !st.hot) {
          console.log(`rsicross ${item.label} ${tf}: cross below zone (ma=${st.ma.toFixed(1)})`);
          continue;
        }
        const key = `rsicross:${item.symbol}:${tf}:${times[i]}`;
        if (await env.DEDUPE.get(key)) continue;
        const stats = `RSI ${st.rsi.toFixed(1)} ↓ MA ${st.ma.toFixed(1)} · ราคา ${divFmt(closes[i])}`;
        const text = lastDiv
          ? `🎯 <b>${item.label}</b> — CONFIRMED SHORT SETUP\n` +
            `🐻 bearish div 15m (${((Date.now() - Number(lastDiv)) / 3600000).toFixed(1)} ชม.ก่อน) + 📉 RSI ตัดลง MA (2H)\n` +
            stats
          : `📉 <b>${item.label}</b> ${tf.toUpperCase()} — RSI ตัดลงใต้เส้น MA\n` +
            stats + `\nโมเมนตัมอ่อนหลังโซนร้อน (MA เดิม ≥ ${CROSS_MA_MIN})`;
        const sent = await sendTelegram(env, `rsicross ${item.label} ${tf}`, text);
        if (sent) await env.DEDUPE.put(key, "1", { expirationTtl: CROSS_DEDUPE_TTL });
      } catch (e) {
        console.log(`rsicross ${item.label} ${tf} error: ${e}`);
      }
    }
  }
}

async function readDivHealth(env: Env): Promise<DivHealth | null> {
  const raw = await env.DEDUPE.get(DIV_HEALTH_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DivHealth;
  } catch {
    return null;
  }
}

async function writeDivHealth(env: Env, h: DivHealth): Promise<void> {
  await env.DEDUPE.put(DIV_HEALTH_KEY, JSON.stringify(h), { expirationTtl: DIV_HEALTH_TTL });
}

// อ่าน lifecycle ของ confirm-watch ต่อเหรียญ (armed/swept/confirmed) — keyed by symbol ให้ dashboard match ได้
type ConfirmState = { state: "armed" | "swept" | "confirmed"; armedHigh?: number; peakHigh?: number; ageMin: number };
async function readConfirmStates(env: Env, list: DivSym[]): Promise<Record<string, ConfirmState>> {
  const out: Record<string, ConfirmState> = {};
  for (const item of list) {
    const raw = await env.DEDUPE.get(`confirm:${item.symbol}`);
    if (raw) {
      try {
        const cw = JSON.parse(raw) as { armedHigh: number; peakHigh: number; swept: boolean; ts: number };
        out[item.symbol] = { state: cw.swept ? "swept" : "armed", armedHigh: cw.armedHigh, peakHigh: cw.peakHigh, ageMin: Math.round((Date.now() - cw.ts) / 60000) };
      } catch { /* skip bad record */ }
    } else {
      const lc = await env.DEDUPE.get(`lastconfirm:${item.symbol}`);
      if (lc) out[item.symbol] = { state: "confirmed", ageMin: Math.round((Date.now() - Number(lc)) / 60000) };
    }
  }
  return out;
}

function jsonResp(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

// add/remove ticker ใน DIV_WATCH (KV) จาก dashboard — guard ด้วย WEBHOOK_SECRET.
// validate จาก edge จริง: ลอง gate (X_USDT) ก่อน, ไม่ได้ค่อย fallback binance (XUSDT) — fetchKlines เช็คแท่ง ≥41 ให้แล้ว
async function handleDivWatchMutate(env: Env, url: URL): Promise<Response> {
  if (url.searchParams.get("token") !== env.DASH_TOKEN) return jsonResp({ ok: false, error: "forbidden" }, 403);
  const action = url.searchParams.get("action");
  const base = (url.searchParams.get("symbol") || "").trim().toUpperCase().replace(/_?USDT$/, "");
  if (!/^[A-Z0-9]{1,15}$/.test(base)) return jsonResp({ ok: false, error: "symbol ไม่ถูกต้อง" });
  const list = await getDivWatch(env);
  const has = (d: DivSym) => d.label === base || d.symbol === `${base}_USDT` || d.symbol === `${base}USDT`;

  if (action === "remove") {
    const next = list.filter((d) => !has(d));
    if (next.length === list.length) return jsonResp({ ok: false, error: `${base} ไม่อยู่ใน div watch` });
    await env.DEDUPE.put(DIVWATCH_KEY, JSON.stringify(next));
    return jsonResp({ ok: true, removed: base, divwatch: next });
  }
  if (action === "add") {
    if (list.some(has)) return jsonResp({ ok: false, error: `${base} อยู่ใน div watch แล้ว` });
    // liveness: futures ที่ delisted ยังคืนแท่งแบน (ราคาเดิมทุกแท่ง) ผ่านเช็ค ≥41 ได้ — เคส SYN 2026-07-02
    const isLive = (kl: Klines | { error: string; code?: number }) =>
      !("error" in kl) && new Set(kl.closes.slice(-20)).size > 1;
    let chosen: DivSym | null = null;
    const candidates: DivSym[] = [
      { symbol: `${base}_USDT`, source: "gate", label: base },
      { symbol: `${base}_USDT`, source: "gate_spot", label: base },
      { symbol: `${base}USDT`, source: "binance", label: base },
    ];
    for (const c of candidates) {
      if (isLive(await fetchKlines(c))) { chosen = c; break; }
    }
    if (!chosen) return jsonResp({ ok: false, error: `${base} ดึงข้อมูลไม่ได้/ตลาดตาย (gate futures+spot, binance edge 451) หรือแท่งไม่พอ` });
    const next = [...list, chosen];
    await env.DEDUPE.put(DIVWATCH_KEY, JSON.stringify(next));
    return jsonResp({ ok: true, added: chosen, divwatch: next });
  }
  return jsonResp({ ok: false, error: "action ต้องเป็น add หรือ remove" });
}

// สถานะเต็มต่อเหรียญสำหรับหน้า /divmanage — RSI 15m + div + cross 1h/2h + lifecycle (3 fetch + KV ไม่กี่ op ต่อ call)
async function handleCoinStatus(env: Env, url: URL): Promise<Response> {
  if (url.searchParams.get("token") !== env.DASH_TOKEN) return jsonResp({ ok: false, error: "forbidden" }, 403);
  const sym = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  const list = await getDivWatch(env);
  const item = list.find((d) => d.symbol === sym || d.label === sym);
  if (!item) return jsonResp({ ok: false, error: "ไม่อยู่ใน div watch" });
  const [k15, k1, k2] = await Promise.all([fetchKlines(item), fetchKlines(item, "1h"), fetchKlines(item, "2h")]);
  let rsi15: number | null = null;
  let div: { age: number; fresh: boolean } | null = null;
  if (!("error" in k15)) {
    const rsi = wilderRSI(k15.closes, 14);
    const last = rsi[rsi.length - 1];
    rsi15 = Number.isNaN(last) ? null : +last.toFixed(1);
    const bear = detectDiv(k15.highs, rsi, swingHighs(k15.highs, DIV_PIVOT_K), "bearish");
    if (bear) {
      const age = k15.closes.length - 1 - bear.p2;
      div = { age, fresh: age <= DIV_FRESH_BARS };
    }
  }
  const cross: Record<string, ReturnType<typeof crossState>> = {};
  if (!("error" in k1)) cross["1h"] = crossState(k1.closes);
  if (!("error" in k2)) cross["2h"] = crossState(k2.closes);
  const ld = await env.DEDUPE.get(`lastdiv:${item.symbol}`);
  let confirm: string | null = null;
  const cw = await env.DEDUPE.get(`confirm:${item.symbol}`);
  if (cw) {
    try { confirm = (JSON.parse(cw) as { swept: boolean }).swept ? "swept" : "armed"; } catch { /* skip */ }
  } else if (await env.DEDUPE.get(`lastconfirm:${item.symbol}`)) confirm = "confirmed";
  return jsonResp({
    ok: true, label: item.label, source: item.source, rsi15, div, cross,
    lastdivMin: ld ? Math.round((Date.now() - Number(ld)) / 60000) : null, confirm,
  });
}

// user พิมพ์ base เปล่า ("WIN") → หา format ที่ suggest บน Actions จะเจอ: gate futures = X_USDT (probe จาก edge ได้),
// ไม่เจอ → สมมติ binance spot = XUSDT (Actions validate ต่อเอง). พิมพ์ format เต็มมา = ใช้ตามนั้น
async function resolveAddSymbol(env: Env, input: string): Promise<string> {
  if (/USDT$/.test(input)) return input; // เต็มอยู่แล้ว (WINUSDT / WIN_USDT)
  const gate = await fetchKlines({ symbol: `${input}_USDT`, source: "gate", label: input });
  const live = !("error" in gate) && new Set(gate.closes.slice(-20)).size > 1;
  return live ? `${input}_USDT` : `${input}USDT`;
}

// คำสั่งพิมพ์ในแชท Telegram — /add /remove /wl (ใช้ backend เดียวกับ /wl route)
async function handleChatCommand(env: Env, cmd: string, arg: string): Promise<void> {
  if (cmd === "wl") {
    const cur = await ghFetchWatchlist(env);
    if ("error" in cur) {
      await sendTelegram(env, "cmd wl", `⚠️ อ่าน watchlist ไม่ได้: ${cur.error}`);
      return;
    }
    const entries = Object.entries(cur.data.tickers ?? {});
    const names = entries.map(([k, v]) => (v.enabled === false ? `${k}(off)` : k)).join(", ");
    await sendTelegram(env, "cmd wl", `📋 <b>watchlist ${entries.length} ตัว</b>\n${names}`);
    return;
  }
  if (!/^[A-Z0-9_]{1,20}$/.test(arg)) {
    await sendTelegram(env, "cmd", `⚠️ ใช้: /${cmd} SYMBOL เช่น /${cmd} CRCL`);
    return;
  }
  const base = arg.replace(/_?USDT$/, "");
  if (cmd === "add") {
    const full = await resolveAddSymbol(env, arg);
    const dkey = `recent:${full}`;
    if (await env.DEDUPE.get(dkey)) {
      await sendTelegram(env, "cmd add", `⏭️ ${full} กำลังเพิ่มอยู่แล้ว`);
      return;
    }
    await env.DEDUPE.put(dkey, "1", { expirationTtl: Math.max(60, parseInt(env.DEDUPE_TTL_SECONDS, 10) || 60) });
    await dispatchAddTicker(env, full);
    await sendTelegram(env, "cmd add", `⏳ <b>${full}</b> เข้าคิวแล้ว — Actions validate+หา levels ~1 นาที`);
    return;
  }
  // remove | rm
  const r = await ghRemoveTicker(env, base);
  await sendTelegram(env, "cmd remove", r.ok ? `✅ ลบ <b>${r.removed}</b> ออกจาก watchlist แล้ว` : `⚠️ ${r.error}`);
}

// list/add/remove watchlist หลัก — GET = list, POST action=add (dispatch ➕ path) | action=remove (contents API)
async function handleWl(env: Env, url: URL, method: "GET" | "POST"): Promise<Response> {
  if (url.searchParams.get("token") !== env.DASH_TOKEN) return jsonResp({ ok: false, error: "forbidden" }, 403);
  if (method === "GET") {
    const cur = await ghFetchWatchlist(env);
    if ("error" in cur) return jsonResp({ ok: false, error: cur.error });
    const tickers = Object.entries(cur.data.tickers ?? {}).map(([symbol, cfg]) => ({
      symbol, exchange: cfg.exchange ?? "?", enabled: cfg.enabled !== false,
    }));
    return jsonResp({ ok: true, count: tickers.length, tickers });
  }
  const action = url.searchParams.get("action");
  const raw = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,20}$/.test(raw)) return jsonResp({ ok: false, error: "symbol ไม่ถูกต้อง" });
  const base = raw.replace(/_?USDT$/, "");
  if (action === "add") {
    const full = await resolveAddSymbol(env, raw);
    await dispatchAddTicker(env, full);
    return jsonResp({ ok: true, queued: full, note: "ส่งเข้า GitHub Actions แล้ว — validate+หา levels ~1 นาที" });
  }
  if (action === "remove") {
    const r = await ghRemoveTicker(env, base);
    return r.ok ? jsonResp({ ok: true, removed: r.removed }) : jsonResp({ ok: false, error: r.error });
  }
  return jsonResp({ ok: false, error: "action ต้องเป็น add หรือ remove" });
}

// หน้าเว็บเล็ก ๆ จัดการ watchlist หลักจาก remote (มือถือ) — สไตล์เดียวกับ /divmanage
async function handleWlManage(env: Env, url: URL): Promise<Response> {
  const htmlHeaders = { "content-type": "text/html; charset=utf-8" };
  if (url.searchParams.get("token") !== env.DASH_TOKEN) {
    return new Response("<h2>forbidden</h2><p>ใส่ ?token=&lt;DASH_TOKEN&gt; ใน URL</p>", { status: 403, headers: htmlHeaders });
  }
  return new Response(wlManagePage(), { status: 200, headers: htmlHeaders });
}

function wlManagePage(): string {
  return `<!doctype html><html lang="th"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WATCHLIST — manage</title>
<style>
:root{color-scheme:dark}
body{font-family:-apple-system,system-ui,sans-serif;background:#0a0f0a;color:#cfe4d6;margin:0 auto;padding:16px;max-width:520px}
h1{font-size:1.05rem;color:#3fd07d;margin:0 0 12px;display:flex;align-items:center;gap:8px}
h1 .n{margin-left:auto;color:#6a9a7c;font-size:.8rem;font-weight:400}
.row{display:flex;align-items:center;gap:8px;padding:9px 4px;border-top:1px solid #1c3a24}
.row .lbl{flex:1;font-weight:600}
.row .lbl .off{color:#888;font-weight:400;font-size:.75rem}
.row .src{color:#6a9a7c;font-size:.72rem}
button{background:#13351f;color:#cfe4d6;border:1px solid #1c5a30;border-radius:6px;padding:9px 14px;font-size:.92rem}
button:active{background:#1c5a30}
.x{background:none;border:none;color:#888;font-size:1.05rem;padding:6px 10px}
.x:active{color:#ff5544}
.add,.filter{display:flex;gap:8px;margin:10px 0 4px}
input{flex:1;min-width:0;background:#0d1b10;color:#cfe4d6;border:1px solid #1c5a30;border-radius:6px;padding:11px;font-size:1rem}
#msg{min-height:1.2rem;font-size:.85rem;margin:6px 0}
.ok{color:#3fd07d}.err{color:#ff5544}.muted{color:#6a9a7c}
</style></head><body>
<h1>&#9646; WATCHLIST &mdash; manage <span class="n" id="count"></span></h1>
<div class="add">
<input id="sym" placeholder="+ ticker เช่น CRCL (ผ่าน Actions ~1 นาที)" autocomplete="off" autocapitalize="characters">
<button id="add">add</button></div>
<div class="filter"><input id="q" placeholder="&#128269; ค้นหา..." autocomplete="off" autocapitalize="characters"></div>
<div id="msg" class="muted"></div>
<div id="list" class="muted">กำลังโหลด...</div>
<script>
var TOKEN=new URLSearchParams(location.search).get('token');
var list=[];
var $=function(id){return document.getElementById(id)};
function render(){
var q=$('q').value.trim().toUpperCase();
var rows=list.filter(function(d){return !q||d.symbol.indexOf(q)>=0});
$('count').textContent=list.length+' ตัว';
$('list').innerHTML=rows.map(function(d){
return '<div class="row"><span class="lbl">'+d.symbol+(d.enabled?'':' <span class="off">(off)</span>')+'</span>'+
'<span class="src">'+d.exchange+'</span><button class="x" data-sym="'+d.symbol+'">&#10005;</button></div>';
}).join('')||'<p class="muted">'+(q?'ไม่พบ':'ว่าง')+'</p>';
}
function setMsg(t,c){var m=$('msg');m.textContent=t;m.className=c||'muted';}
function load(){
fetch('/wl?token='+encodeURIComponent(TOKEN)).then(function(r){return r.json()}).then(function(d){
if(d.ok){list=d.tickers;render();}else setMsg('\\u26a0\\ufe0f '+(d.error||'โหลดไม่ได้'),'err');
}).catch(function(e){setMsg('\\u26a0\\ufe0f '+e,'err')});
}
function mutate(action,symbol){
setMsg((action==='add'?'ส่งเข้า Actions ':'กำลังลบ ')+symbol+'...','muted');
fetch('/wl?token='+encodeURIComponent(TOKEN)+'&action='+action+'&symbol='+encodeURIComponent(symbol),{method:'POST'})
.then(function(r){return r.json()}).then(function(d){
if(d.ok&&action==='remove'){setMsg('\\u2705 ลบ '+d.removed,'ok');load();}
else if(d.ok){setMsg('\\u23F3 '+d.queued+' เข้าคิวแล้ว \\u2014 Actions หา levels ~1 นาที แล้วกดค้นหาซ้ำ','ok');$('sym').value='';}
else setMsg('\\u26a0\\ufe0f '+(d.error||'ล้มเหลว'),'err');
}).catch(function(e){setMsg('\\u26a0\\ufe0f '+e,'err')});
}
$('add').onclick=function(){var v=$('sym').value.trim();if(v)mutate('add',v)};
$('sym').addEventListener('keydown',function(e){if(e.key==='Enter'){var v=$('sym').value.trim();if(v)mutate('add',v)}});
$('q').addEventListener('input',render);
$('list').addEventListener('click',function(e){var b=e.target.closest('[data-sym]');
if(b&&confirm('ลบ '+b.dataset.sym+' ออกจาก watchlist?'))mutate('remove',b.dataset.sym)});
load();
</script></body></html>`;
}

// หน้าเว็บเล็ก ๆ จัดการ div watch จาก remote (มือถือ) — token ใน URL, เรียก /divwatch ของ worker เอง
async function handleDivManage(env: Env, url: URL): Promise<Response> {
  const htmlHeaders = { "content-type": "text/html; charset=utf-8" };
  if (url.searchParams.get("token") !== env.DASH_TOKEN) {
    return new Response("<h2>forbidden</h2><p>ใส่ ?token=&lt;DASH_TOKEN&gt; ใน URL</p>", { status: 403, headers: htmlHeaders });
  }
  const list = await getDivWatch(env);
  return new Response(divManagePage(JSON.stringify(list)), { status: 200, headers: htmlHeaders });
}

function divManagePage(listJson: string): string {
  return `<!doctype html><html lang="th"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DIV WATCH — manage</title>
<style>
:root{color-scheme:dark}
body{font-family:-apple-system,system-ui,sans-serif;background:#0a0f0a;color:#cfe4d6;margin:0 auto;padding:16px;max-width:520px}
h1{font-size:1.05rem;color:#3fd07d;margin:0 0 12px;display:flex;align-items:center;gap:8px}
h1 .rf{margin-left:auto}
.row{padding:9px 4px;border-top:1px solid #1c3a24}
.main{display:flex;align-items:center;gap:8px}
.main .lbl{flex:1;font-weight:600}
.main .rsi{font-variant-numeric:tabular-nums}
.rsi.hot{color:#ffb04d}.rsi.cool{color:#6a9a7c}
.bdg{font-size:.78rem;white-space:nowrap}
.bdg.red{color:#ff5544;font-weight:600}.bdg.amb{color:#ffb04d}.bdg.dim{color:#6a9a7c}
.sub{display:flex;gap:12px;font-size:.74rem;padding:3px 0 0 2px;min-height:1em}
.tf{white-space:nowrap;color:#6a9a7c}
.tf.red{color:#ff5544;font-weight:600}.tf.yel{color:#ffb04d}
button{background:#13351f;color:#cfe4d6;border:1px solid #1c5a30;border-radius:6px;padding:9px 14px;font-size:.92rem}
button:active{background:#1c5a30}
.x{background:none;border:none;color:#888;font-size:1.05rem;padding:6px 10px}
.x:active{color:#ff5544}
.rf{background:none;border:1px solid #1c5a30;border-radius:6px;color:#6a9a7c;font-size:.8rem;padding:5px 10px}
.add{display:flex;gap:8px;margin:14px 0 4px}
.add input{flex:1;min-width:0;background:#0d1b10;color:#cfe4d6;border:1px solid #1c5a30;border-radius:6px;padding:11px;font-size:1rem}
#msg{min-height:1.2rem;font-size:.85rem;margin:6px 0}
.ok{color:#3fd07d}.err{color:#ff5544}.muted{color:#6a9a7c}
</style></head><body>
<h1>&#9646; 15m DIV WATCH &mdash; manage <button class="rf" id="rf">&#8635; refresh</button></h1>
<div class="add">
<input id="sym" placeholder="+ ticker เช่น TAC" autocomplete="off" autocapitalize="characters">
<button id="add">add</button></div>
<div id="msg" class="muted"></div>
<div id="list"></div>
<script>
var TOKEN=new URLSearchParams(location.search).get('token');
var list=${listJson};
var $=function(id){return document.getElementById(id)};
function render(){
$('list').innerHTML=list.map(function(d){
return '<div class="row"><div class="main"><span class="lbl">'+d.label+'</span>'+
'<span class="rsi cool" id="rsi-'+d.label+'">&ndash;</span>'+
'<span class="bdg dim" id="bdg-'+d.label+'">&hellip;</span>'+
'<button class="x" data-sym="'+d.label+'">&#10005;</button></div>'+
'<div class="sub" id="sub-'+d.label+'"></div></div>';
}).join('')||'<p class="muted">ว่าง</p>';
}
function chip(tf,c){
if(!c)return '<span class="tf">'+tf.toUpperCase()+' &ndash;</span>';
var a=c.crossed?'\\u2702\\uFE0F':(c.below?'\\u2193':'\\u2191');
var cls=c.crossed&&c.hot?'tf red':(c.below?'tf yel':'tf');
return '<span class="'+cls+'">'+tf.toUpperCase()+' '+a+Math.round(c.rsi)+'/'+Math.round(c.ma)+'</span>';
}
function badge(s){
if(s.confirm==='confirmed')return ['\\uD83C\\uDFAF confirmed','red'];
if(s.confirm==='swept')return ['\\u23F3 swept','amb'];
if(s.confirm==='armed')return ['\\uD83D\\uDD2B armed','amb'];
if(s.div&&s.div.fresh)return ['\\uD83D\\uDC3B bearish div','red'];
if(s.div)return ['div '+s.div.age+'b เก่า','dim'];
if(s.rsi15!=null&&s.rsi15>=65)return ['RSI hot','amb'];
return ['quiet','dim'];
}
function loadStatus(){
list.forEach(function(d){
fetch('/coinstatus?token='+encodeURIComponent(TOKEN)+'&symbol='+encodeURIComponent(d.symbol))
.then(function(r){return r.json()}).then(function(s){
if(!s.ok)return;
var r=$('rsi-'+d.label),b=$('bdg-'+d.label),u=$('sub-'+d.label);
if(!r)return;
r.textContent=s.rsi15!=null?s.rsi15.toFixed(1):'?';
r.className='rsi '+(s.rsi15!=null&&s.rsi15>=65?'hot':'cool');
var bd=badge(s);b.innerHTML=bd[0];b.className='bdg '+bd[1];
var h='';
h+=chip('1h',s.cross&&s.cross['1h']);
h+=chip('2h',s.cross&&s.cross['2h']);
var c2=s.cross&&s.cross['2h'];
if(s.lastdivMin!=null&&c2&&(c2.crossed||c2.below))h+='<span class="tf red">\\uD83C\\uDFAF div '+(s.lastdivMin/60).toFixed(1)+'\\u0E0A\\u0E21.+2H</span>';
else if(s.lastdivMin!=null)h+='<span class="tf">\\uD83D\\uDC3B div '+(s.lastdivMin/60).toFixed(1)+'\\u0E0A\\u0E21.</span>';
u.innerHTML=h;
}).catch(function(){});
});
}
function setMsg(t,c){var m=$('msg');m.textContent=t;m.className=c||'muted';}
function mutate(action,symbol){
setMsg((action==='add'?'กำลังเพิ่ม+ตรวจสอบ ':'กำลังลบ ')+symbol+'...','muted');
fetch('/divwatch?token='+encodeURIComponent(TOKEN)+'&action='+action+'&symbol='+encodeURIComponent(symbol),{method:'POST'})
.then(function(r){return r.json()}).then(function(d){
if(d.ok){list=d.divwatch;render();loadStatus();setMsg(action==='add'?('\\u2705 เพิ่ม '+(d.added&&d.added.label)+' ('+(d.added&&d.added.source)+')'):('\\u2705 ลบ '+d.removed),'ok');if(action==='add')$('sym').value='';}
else setMsg('\\u26a0\\ufe0f '+(d.error||'ล้มเหลว'),'err');
}).catch(function(e){setMsg('\\u26a0\\ufe0f '+e,'err')});
}
$('add').onclick=function(){var v=$('sym').value.trim();if(v)mutate('add',v)};
$('sym').addEventListener('keydown',function(e){if(e.key==='Enter'){var v=$('sym').value.trim();if(v)mutate('add',v)}});
$('list').addEventListener('click',function(e){var b=e.target.closest('[data-sym]');if(b)mutate('remove',b.dataset.sym)});
$('rf').onclick=loadStatus;
render();loadStatus();
</script></body></html>`;
}

// dead-man heartbeat: tick แรกของแต่ละวัน UTC ส่ง 1 บรรทัด — ถ้าวันไหนไม่มา = worker ตายทั้งตัว
async function maybeHeartbeat(env: Env, symbols: DivHealth["symbols"]): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (await env.DEDUPE.get(`divhb:${today}`)) return;
  const entries = Object.entries(symbols);
  const errs = entries.filter(([, v]) => FETCH_ERROR_STATUSES.has(v.status));
  const text =
    errs.length === 0
      ? `✅ 15m watcher alive — ${entries.length}/${entries.length} เหรียญดึงข้อมูลได้`
      : `⚠️ 15m watcher alive แต่ ${errs.length}/${entries.length} fetch fail: ` +
        errs.map(([k, v]) => `${k}(${v.status}${v.code ?? ""})`).join(", ");
  const sent = await sendTelegram(env, "watcher-heartbeat", text);
  if (sent) await env.DEDUPE.put(`divhb:${today}`, "1", { expirationTtl: 26 * 3600 });
}

// ดึง klines → normalize เป็น {highs, closes, times(ms)} จาก 2 format:
// binance spot (array ของ array, t=ms) | gate futures (array ของ object {h,c,t}, t=วินาที)
type Klines = { highs: number[]; lows: number[]; closes: number[]; times: number[] };
async function fetchKlines(item: DivSym, interval = "15m", limit = 150): Promise<Klines | { error: string; code?: number }> {
  const url =
    item.source === "gate"
      ? `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${item.symbol}&interval=${interval}&limit=${limit}`
      : item.source === "gate_spot"
        ? `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${item.symbol}&interval=${interval}&limit=${limit}`
        : `${KLINES_BASE}/api/v3/klines?symbol=${item.symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { headers: { "user-agent": KLINES_UA } });
  if (!res.ok) return { error: "klines_http_error", code: res.status };
  const raw = (await res.json()) as unknown[];
  if (!Array.isArray(raw) || raw.length < 41) return { error: "too_few_klines" };
  const k = raw.slice(0, -1); // ตัดแท่งกำลังก่อตัวทิ้ง → closed only (กัน whipsaw, gotcha #9)
  if (item.source === "gate") {
    const a = k as { h: string; l: string; c: string; t: number }[];
    return {
      highs: a.map((r) => parseFloat(r.h)), lows: a.map((r) => parseFloat(r.l)),
      closes: a.map((r) => parseFloat(r.c)), times: a.map((r) => r.t * 1000),
    };
  }
  if (item.source === "gate_spot") {
    // spot format: [t(วินาที str), quote_vol, close, high, low, open, base_amount, closed_flag]
    const a = k as string[][];
    return {
      highs: a.map((r) => parseFloat(r[3])), lows: a.map((r) => parseFloat(r[4])),
      closes: a.map((r) => parseFloat(r[2])), times: a.map((r) => Number(r[0]) * 1000),
    };
  }
  const a = k as string[][];
  return {
    highs: a.map((r) => parseFloat(r[2])), lows: a.map((r) => parseFloat(r[3])),
    closes: a.map((r) => parseFloat(r[4])), times: a.map((r) => Number(r[0])),
  };
}

// swing low = low[i] ต่ำกว่า k แท่งทั้งสองข้าง (mirror ของ swingHighs)
function swingLows(lows: number[], k: number): number[] {
  const out: number[] = [];
  for (let i = k; i < lows.length - k; i++) {
    let ok = true;
    for (let j = 1; j <= k; j++) {
      if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

// หา divergence จาก pivot series — dir "bearish" เทียบยอดสูงสุดใน window, "bullish" เทียบก้นต่ำสุด
function detectDiv(
  prices: number[], rsi: number[], pivots: number[], dir: "bearish" | "bullish",
): { p1: number; p2: number } | null {
  if (pivots.length < 2) return null;
  const p2 = pivots[pivots.length - 1];
  const win = pivots.filter((i) => i < p2 && i >= p2 - DIV_LOOKBACK_BARS);
  if (win.length === 0) return null;
  let p1 = win[0];
  for (const i of win) if (dir === "bearish" ? prices[i] > prices[p1] : prices[i] < prices[p1]) p1 = i;
  if (Number.isNaN(rsi[p1]) || Number.isNaN(rsi[p2])) return null;
  const ok =
    dir === "bearish"
      ? prices[p2] > prices[p1] && rsi[p2] < rsi[p1] && rsi[p1] >= DIV_RSI_MIN
      : prices[p2] < prices[p1] && rsi[p2] > rsi[p1] && rsi[p1] <= DIV_RSI_MAX_LOW;
  return ok ? { p1, p2 } : null;
}

// ATR(14) บนแท่ง 15m (ค่าเฉลี่ย TR ธรรมดา) — ใช้กะ buffer ของ stop เหนือ wick กระชาก
function atr14(highs: number[], lows: number[], closes: number[], period = 14): number {
  const n = closes.length;
  if (n < period + 1) return 0;
  let sum = 0;
  for (let i = n - period; i < n; i++) {
    sum += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  return sum / period;
}

async function checkDivergence(env: Env, item: DivSym): Promise<Record<string, unknown>> {
  const symbol = item.label;
  const kl = await fetchKlines(item);
  if ("error" in kl) return kl.code ? { symbol, status: kl.error, code: kl.code } : { symbol, status: kl.error };
  const { highs, lows, closes, times } = kl;
  const rsi = wilderRSI(closes, 14);
  const lastIdx = closes.length - 1;
  const fresh = (p2: number) => lastIdx - p2 <= DIV_FRESH_BARS;

  // ---- FLIP: bullish divergence ที่ก้น หลัง bearish div เปิด flip-watch ไว้ ----
  const bull = detectDiv(lows, rsi, swingLows(lows, DIV_PIVOT_K), "bullish");
  if (bull && fresh(bull.p2) && (await env.DEDUPE.get(`flip:${item.symbol}`))) {
    const diag = { symbol, dir: "flip", p1: { l: lows[bull.p1], rsi: +rsi[bull.p1].toFixed(1) }, p2: { l: lows[bull.p2], rsi: +rsi[bull.p2].toFixed(1) } };
    const fkey = `divflip:${item.symbol}:${times[bull.p2]}`;
    if (await env.DEDUPE.get(fkey)) return { ...diag, status: "flip_deduped" };
    const sent = await sendFlipAlert(env, symbol, lows, rsi, times, bull.p1, bull.p2);
    if (sent) {
      await env.DEDUPE.put(fkey, "1", { expirationTtl: DIV_DEDUPE_TTL });
      await env.DEDUPE.delete(`flip:${item.symbol}`); // ปิด flip-watch หลังแจ้ง flip แล้ว
    }
    return { ...diag, status: sent ? "flip_sent" : "flip_send_failed" };
  }

  // ---- CONFIRM stage: symbol ที่ arm ไว้แล้ว — รอ sweep+reclaim ก่อนส่ง entry จริง ----
  const cwRaw = await env.DEDUPE.get(`confirm:${item.symbol}`);
  if (cwRaw) {
    let cw: { armedHigh: number; peakHigh: number; swept: boolean; ts: number } | null = null;
    try { cw = JSON.parse(cwRaw); } catch { cw = null; }
    if (cw) {
      if (Date.now() - cw.ts > CONFIRM_WATCH_TTL * 1000) {
        await env.DEDUPE.delete(`confirm:${item.symbol}`); // setup หมดอายุ ไม่เข้าแล้ว
        return { symbol, status: "confirm_expired" };
      }
      const recentHigh = Math.max(...highs.slice(-CONFIRM_PEAK_BARS));
      const peakHigh = Math.max(cw.peakHigh, recentHigh);
      const swept = cw.swept || recentHigh > cw.armedHigh; // ราคากระชากเหนือไฮ div แล้วหรือยัง
      const lastClose = closes[lastIdx];
      if (swept && lastClose < cw.armedHigh) {
        // reclaim: กระชากกวาดไฮแล้วปิดกลับลงใต้ไฮ div → จังหวะเข้าหลังกระชากจบ
        const stop = peakHigh + CONFIRM_STOP_ATR * atr14(highs, lows, closes);
        const ckey = `confirmed:${item.symbol}:${Math.round(cw.ts / 1000)}`;
        if (await env.DEDUPE.get(ckey)) return { symbol, status: "confirm_deduped" };
        const sent = await sendEntryAlert(env, symbol, lastClose, cw.armedHigh, peakHigh, stop);
        if (sent) {
          await env.DEDUPE.put(ckey, "1", { expirationTtl: CONFIRM_DEDUPE_TTL });
          await env.DEDUPE.put(`lastconfirm:${item.symbol}`, String(Date.now()), { expirationTtl: CONFIRM_RECENT_TTL }); // ให้ dashboard โชว์ "confirmed"
          await env.DEDUPE.delete(`confirm:${item.symbol}`);
        }
        return { symbol, status: sent ? "confirm_entry_sent" : "confirm_send_failed", entry: lastClose, stop };
      }
      // ยังไม่ confirm — อัปเดต peak/sweep ไว้แล้วเฝ้าต่อ
      await env.DEDUPE.put(`confirm:${item.symbol}`, JSON.stringify({ ...cw, peakHigh, swept }), { expirationTtl: CONFIRM_WATCH_TTL });
      return { symbol, status: swept ? "confirm_swept_waiting" : "confirm_armed", armedHigh: cw.armedHigh, peakHigh };
    }
  }

  // ---- BEARISH divergence ที่ยอด (fade-the-top) → arm confirm-watch (ยังไม่ใช่ entry) ----
  const bear = detectDiv(highs, rsi, swingHighs(highs, DIV_PIVOT_K), "bearish");
  if (!bear) return { symbol, status: "no_divergence" };
  const { p1, p2 } = bear;
  const diag = { symbol, dir: "bearish", p1: { h: highs[p1], rsi: +rsi[p1].toFixed(1) }, p2: { h: highs[p2], rsi: +rsi[p2].toFixed(1) }, bearish: true };
  if (!fresh(p2)) return { ...diag, status: "stale", ageBars: lastIdx - p2 };

  const key = `div:${item.symbol}:${times[p2]}`;
  if (await env.DEDUPE.get(key)) return { ...diag, status: "deduped" };

  // เขียน dedupe หลังส่งสำเร็จเท่านั้น — กันเผา key ทิ้งตอนส่งไม่สำเร็จ (เช่น CHAT_ID ยังไม่ตั้ง)
  const sent = await sendDivergenceAlert(env, symbol, highs, rsi, times, p1, p2);
  if (sent) {
    await env.DEDUPE.put(key, "1", { expirationTtl: DIV_DEDUPE_TTL });
    await env.DEDUPE.put(`flip:${item.symbol}`, String(times[p2]), { expirationTtl: FLIP_WATCH_TTL }); // เปิด flip-watch
    // arm confirm-watch: รอ sweep+reclaim ก่อนค่อยให้สัญญาณ entry จริง (stage 2)
    await env.DEDUPE.put(`confirm:${item.symbol}`,
      JSON.stringify({ armedHigh: highs[p2], peakHigh: highs[p2], swept: false, ts: Date.now() }),
      { expirationTtl: CONFIRM_WATCH_TTL });
    // marker ให้ RSI×MA cross watcher อัปเกรดเป็น 🎯 CONFIRMED เมื่อ 2h ตัดลงตามใน 24 ชม.
    await env.DEDUPE.put(`lastdiv:${item.symbol}`, String(Date.now()), { expirationTtl: LASTDIV_TTL });
  }
  return { ...diag, status: sent ? "armed" : "send_failed" };
}

const divFmt = (p: number) => (p >= 1 ? p.toFixed(2) : p.toPrecision(4));
const divTs = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace("T", " ") + " UTC";

async function sendTelegram(env: Env, tag: string, text: string): Promise<boolean> {
  if (!env.BOT_TOKEN || !env.CHAT_ID) {
    console.log(`${tag}: BOT_TOKEN/CHAT_ID not set`);
    return false;
  }
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) console.log(`${tag}: telegram ${r.status}`);
  return r.ok;
}

async function sendDivergenceAlert(
  env: Env, symbol: string, highs: number[], rsi: number[], times: number[], p1: number, p2: number,
): Promise<boolean> {
  const text =
    `🐻 <b>${symbol} bearish divergence (15m) — setup armed</b>\n` +
    `ราคาทำ higher high แต่ RSI lower high — fade-the-top\n` +
    `⏳ <b>ยังไม่เข้า</b> — รอ sweep+reclaim (กระชากกวาดไฮแล้วปิดกลับลง) ค่อยส่ง 🎯 entry\n\n` +
    `High 1: $${divFmt(highs[p1])} · RSI ${rsi[p1].toFixed(1)} · ${divTs(times[p1])}\n` +
    `High 2: $${divFmt(highs[p2])} · RSI ${rsi[p2].toFixed(1)} · ${divTs(times[p2])} ⬅️ ไฮ div`;
  return sendTelegram(env, `divergence ${symbol}`, text);
}

async function sendEntryAlert(
  env: Env, symbol: string, entry: number, armedHigh: number, sweptHigh: number, stop: number,
): Promise<boolean> {
  const riskPct = entry > 0 ? ((stop - entry) / entry) * 100 : 0;
  const text =
    `🎯 <b>${symbol} confirmed short entry (15m)</b>\n` +
    `กระชากกวาดไฮ $${divFmt(sweptHigh)} แล้ว reclaim ปิดใต้ไฮ div $${divFmt(armedHigh)} → เข้าหลังกระชากจบ\n\n` +
    `Entry ~$${divFmt(entry)}\n` +
    `Stop $${divFmt(stop)} (เหนือ wick กระชาก +${CONFIRM_STOP_ATR}×ATR) · ระยะ ~${riskPct.toFixed(1)}%\n` +
    `⚠️ size ตาม stop นี้ — อย่าใช้ leverage จน stop = จุด liquidation`;
  return sendTelegram(env, `entry ${symbol}`, text);
}

async function sendFlipAlert(
  env: Env, symbol: string, lows: number[], rsi: number[], times: number[], p1: number, p2: number,
): Promise<boolean> {
  const text =
    `🔄 <b>${symbol} divergence flipped (15m)</b>\n` +
    `หลัง bearish div — ตอนนี้ราคาทำ lower low แต่ RSI higher low = bullish divergence ที่ก้น\n\n` +
    `Low 1: $${divFmt(lows[p1])} · RSI ${rsi[p1].toFixed(1)} · ${divTs(times[p1])}\n` +
    `Low 2: $${divFmt(lows[p2])} · RSI ${rsi[p2].toFixed(1)} · ${divTs(times[p2])} ⬅️ ราคาต่ำกว่า RSI สูงกว่า`;
  return sendTelegram(env, `flip ${symbol}`, text);
}

// ---- main watchlist (watchlist.json ใน repo) จัดการผ่าน GitHub Contents API ----
// add ใช้เส้นทาง repository_dispatch เดิม (ปุ่ม ➕) เพราะต้อง suggest levels บน Actions;
// remove แก้ไฟล์ตรง = เห็นผลทันที. format: JSON.parse/stringify รักษาลำดับ key ตรง save_config
// (sort_keys=False) และ refresh-levels.yml เขียนทับทุกเช้าอยู่แล้ว — drift เรื่อง float repr self-heal
type WatchlistFile = { settings?: Record<string, unknown>; tickers?: Record<string, { exchange?: string; enabled?: boolean }> };

function ghHeaders(env: Env): Record<string, string> {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "crypto-rsi-webhook",
  };
}

function b64decodeUtf8(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function b64encodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}

async function ghFetchWatchlist(env: Env): Promise<{ data: WatchlistFile; sha: string } | { error: string }> {
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/watchlist.json?ref=main`, {
    headers: ghHeaders(env),
  });
  if (!r.ok) return { error: `github read ${r.status}` };
  const j = (await r.json()) as { content: string; sha: string };
  try {
    return { data: JSON.parse(b64decodeUtf8(j.content)) as WatchlistFile, sha: j.sha };
  } catch {
    return { error: "watchlist.json parse failed" };
  }
}

// ลบ ticker ออกจาก watchlist.json บน main โดยตรง — optimistic lock ด้วย sha, retry กัน race กับ Actions
async function ghRemoveTicker(env: Env, base: string): Promise<{ ok: true; removed: string } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await ghFetchWatchlist(env);
    if ("error" in cur) return { ok: false, error: cur.error };
    const tickers = cur.data.tickers ?? {};
    const key = Object.keys(tickers).find((k) => k.replace(/_?USDT$/, "") === base);
    if (!key) return { ok: false, error: `${base} ไม่อยู่ใน watchlist` };
    delete tickers[key];
    const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/watchlist.json`, {
      method: "PUT",
      headers: ghHeaders(env),
      body: JSON.stringify({
        message: `watchlist: remove ${key} via mobile`,
        content: b64encodeUtf8(JSON.stringify(cur.data, null, 2) + "\n"),
        sha: cur.sha,
        branch: "main",
      }),
    });
    if (r.ok) return { ok: true, removed: key };
    if (r.status !== 409 && r.status !== 422) return { ok: false, error: `github write ${r.status}` };
    // sha ชน (มี commit แทรก) → วนอ่านใหม่
  }
  return { ok: false, error: "sha conflict 3 รอบ — ลองใหม่อีกครั้ง" };
}

async function dispatchAddTicker(env: Env, symbol: string): Promise<void> {
  await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "crypto-rsi-webhook",
    },
    body: JSON.stringify({
      event_type: "add_ticker",
      client_payload: { symbol },
    }),
  });
}
