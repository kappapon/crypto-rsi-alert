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
}

interface InlineButton {
  text: string;
  callback_data?: string;
}

interface TelegramUpdate {
  update_id: number;
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
type DivSym = { symbol: string; source: "binance" | "gate"; label: string };
const DIV_WATCH: DivSym[] = [
  { symbol: "SYN_USDT", source: "gate", label: "SYN" },
  { symbol: "BEL_USDT", source: "gate", label: "BEL" },
  { symbol: "MMT_USDT", source: "gate", label: "MMT" },
  { symbol: "DEXE_USDT", source: "gate", label: "DEXE" },
  { symbol: "AWE_USDT", source: "gate", label: "AWE" },
  { symbol: "G_USDT", source: "gate", label: "G" },
  { symbol: "FOLKS_USDT", source: "gate", label: "FOLKS" },
  { symbol: "BAS_USDT", source: "gate", label: "BAS" },
];
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
    if (DIV_MINUTES.includes(new Date(event.scheduledTime).getUTCMinutes())) {
      tasks.push(runDivergenceWatch(env));
    }
    ctx.waitUntil(Promise.all(tasks));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "GET") {
      // GET /health?token=<WEBHOOK_SECRET> — สถานะ watcher ล่าสุด (แทน temp debug route + wrangler tail ที่ไม่นิ่ง)
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        if (url.searchParams.get("token") !== env.WEBHOOK_SECRET) {
          return new Response("forbidden", { status: 403 });
        }
        const h = await readDivHealth(env);
        const confirm = await readConfirmStates(env); // lifecycle armed/swept/confirmed ต่อเหรียญ — ให้ dashboard โชว์
        const body = h
          ? { ...h, iso: new Date(h.ts).toISOString(), ageMinutes: Math.round((Date.now() - h.ts) / 60000), confirm }
          : { error: "no health record — watcher ไม่ได้ tick ภายใน TTL (อาจตายทั้งตัว)", confirm };
        return new Response(JSON.stringify(body, null, 2), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("ok", { status: 200 });
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
  const symbols: DivHealth["symbols"] = {};
  const crossed: { label: string; status: string; code?: number }[] = [];

  for (const item of DIV_WATCH) {
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
async function readConfirmStates(env: Env): Promise<Record<string, ConfirmState>> {
  const out: Record<string, ConfirmState> = {};
  for (const item of DIV_WATCH) {
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
async function fetchKlines(item: DivSym): Promise<Klines | { error: string; code?: number }> {
  const url =
    item.source === "gate"
      ? `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${item.symbol}&interval=15m&limit=150`
      : `${KLINES_BASE}/api/v3/klines?symbol=${item.symbol}&interval=15m&limit=150`;
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
