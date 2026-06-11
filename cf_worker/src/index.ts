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

// ---- Scheduled triggers: Worker เป็นนาฬิกาแทน GitHub cron (โดน throttle 1-3 ชม.) ----
// จับคู่ด้วย "เวลา tick" ไม่ใช่ cron string — Cloudflare อาจ normalize string จน map ตรง ๆ พลาด
// เวลาไทย = UTC+7: 00:10 → 07:10 refresh, 00:20 → 07:20 reversal+tracker, :23 ทุก 4 ชม. → rsi+watchlist
function workflowsForTick(scheduledTime: number): string[] {
  const d = new Date(scheduledTime);
  const m = d.getUTCMinutes();
  const h = d.getUTCHours();
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
    ctx.waitUntil(Promise.all(files.map((f) => dispatchWorkflow(env, f))));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
