# Crypto RSI — Cloudflare Worker (Telegram webhook)

Replaces the polling `telegram-handler.yml` cron. Provides sub-second toast feedback when a user taps the ➕ button on an RSI alert.

## Architecture

```
Telegram → POST /telegram → Worker
                              ├─ verify X-Telegram-Bot-Api-Secret-Token
                              ├─ KV dedupe (TTL 30s per symbol)
                              ├─ answerCallbackQuery (toast)
                              ├─ editMessageText (append ✅)
                              └─ POST repos/.../dispatches → add-ticker.yml
```

## One-time setup

```bash
cd cf_worker
npm install
npx wrangler login                 # browser OAuth
npx wrangler kv namespace create DEDUPE
#   → paste returned id into wrangler.toml under [[kv_namespaces]]

# secrets
npx wrangler secret put BOT_TOKEN           # same as GitHub Actions secret
npx wrangler secret put WEBHOOK_SECRET      # random e.g. `openssl rand -hex 24`
npx wrangler secret put GITHUB_TOKEN        # PAT with `repo` scope

npx wrangler deploy
# → note the worker URL, e.g. https://crypto-rsi-webhook.<acct>.workers.dev
```

## Register webhook with Telegram

```bash
WORKER_URL="https://crypto-rsi-webhook.<acct>.workers.dev"
SECRET="<the WEBHOOK_SECRET you just set>"
BOT_TOKEN="<bot token>"

curl -sS "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d url="${WORKER_URL}" \
  -d secret_token="${SECRET}" \
  -d allowed_updates='["callback_query"]'
```

Verify with:

```bash
curl -sS "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

## After webhook is live

Disable the polling cron in `.github/workflows/telegram-handler.yml`
(comment out the `schedule:` block, keep `workflow_dispatch` as fallback).
Otherwise polling + webhook will race for the same `callback_query`.

## Local dev

```bash
npx wrangler dev      # localhost:8787
# expose with cloudflared tunnel or ngrok for end-to-end tests
```
