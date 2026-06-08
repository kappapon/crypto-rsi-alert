# Crypto RSI Alert

แจ้งเตือนผ่าน Telegram เมื่อคู่เหรียญ USDT บน Binance มี **Daily RSI(14) > 70** (overbought) หรือ **> 80** (extreme) — ตรวจทุก 4 ชั่วโมงจาก live candle รันบน GitHub Actions ฟรี

> 📖 **เพิ่งเริ่มใช้?** ดู [USAGE.md](USAGE.md) — คู่มือผู้ใช้ทีละขั้นตอน (Setup → Add → Activate → Alert)

## 🚀 Quick Start

```bash
# 1. Setup (ครั้งเดียว) — ดูรายละเอียดด้านล่าง
git clone <repo> && cd crypto_rsi_alert
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# → ใส่ BOT_TOKEN + CHAT_ID ใน GitHub Secrets
# → เปิด Actions tab → enable workflows

# 2. เพิ่ม ticker เข้า watchlist (auto-suggest key levels)
python manage_watchlist.py suggest BTCUSDT

# 3. ดู / แก้ / ปิด
python manage_watchlist.py list
python manage_watchlist.py set BTCUSDT -j 64000
python manage_watchlist.py disable BTCUSDT

# 4. Activate (workflow รันทุก 10 นาที)
git add watchlist.json && git commit -m "watchlist: BTCUSDT" && git push
```

ครบแล้ว — รอ Telegram alert ได้เลย ✅

### 📊 Dashboard (เห็นทุก ticker real-time ใน browser)

```bash
python3 dashboard_server.py
# → เปิด http://localhost:8765/dashboard/
```

Features: live price, sparkline 24h, scenario badge, distance to levels (color-coded),
position calculator, sound alert, add ticker → suggest levels in browser

## How it works

- รัน cron ทุก 4 ชั่วโมง ที่นาทีที่ 10 UTC (00:10, 04:10, 08:10, 12:10, 16:10, 20:10 UTC)
- ดึง symbol USDT spot ที่ status TRADING ทั้งหมด (~400)
- คำนวณ RSI(14) แบบ Wilder (ตรงกับ TradingView) จาก daily candle ที่กำลังวิ่งอยู่ (live) — ค่า RSI จะอัปเดตระหว่างวัน
- Alert logic 2 ระดับ:
  - ⚠️ ข้าม 70 ขึ้น → แจ้งครั้งเดียวต่อวัน
  - 🚨 ข้าม 80 ขึ้น → แจ้งครั้งเดียวต่อวัน (เพิ่มเติมจาก 70)
  - State reset ทุก 00:00 UTC (07:00 ไทย) — รอบใหม่พร้อมแจ้งใหม่ได้
- เก็บ state ใน `state.json` — workflow commit กลับเข้า repo เอง

## 🔘 Interactive Add (Telegram button → watchlist)

ทุก RSI alert ใน Telegram จะมีปุ่ม **➕ SYMBOL** แนบมาด้วย — กดปุ่มเดียวเพิ่มเข้า watchlist (auto-calc levels) โดยไม่ต้องเปิดเครื่อง

**ขั้นตอน:**
1. Telegram ได้รับ alert พร้อมปุ่ม ➕ ต่อ ticker
2. แตะปุ่ม ➕ SYMBOL ที่อยากเทรด
3. รอ **5-15 นาที** (workflow `Telegram Handler` รัน */5 นาที พร้อม cron drift)
4. ข้อความเดิมจะถูก edit แสดง `✅ SYMBOL added to watchlist` + ติ๊กที่ Telegram toast
5. ticker ถูก commit เข้า `watchlist.json` → workflow Watchlist Alert รอบถัดไปจะแจ้ง breakout/rejection ให้

**Architecture:** polling (ไม่ใช่ webhook)
- `telegram_handler.py` รัน `getUpdates` ทุก 5 นาที → handle `callback_query` ขึ้นต้น `add:`
- เรียก `manage_watchlist.py suggest <SYMBOL> --yes` (skip prompt, auto-detect exchange + suggest levels)
- บันทึก `last_update_id` ใน `telegram_state.json` → workflow commit กลับ repo

**ข้อจำกัด:**
- Latency 5-15 นาที (cron drift) — ถ้าต้องการ realtime ต้องเปลี่ยนเป็น Cloudflare Worker webhook
- ปุ่มยังกดได้หลายครั้ง — ครั้งที่ 2+ จะ overwrite ค่าด้วย suggested ใหม่ (idempotent)
- ถ้า symbol ไม่อยู่บน Binance Futures/Spot/Gate.io → จะตอบ ❌ ผ่าน callback alert

## Setup (ทำครั้งเดียว)

### 1. สร้าง Telegram bot

1. เปิด Telegram → ค้น `@BotFather` → `/newbot`
2. ตั้งชื่อ bot → ได้ **BOT_TOKEN** หน้าตา `123456:ABC-DEF...`
3. ส่งข้อความอะไรก็ได้ไปหา bot ที่เพิ่งสร้าง
4. เปิด URL นี้ใน browser (แทน `<TOKEN>` ด้วย token):
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
5. หา `"chat":{"id": 123456789` → ตัวเลขนั้นคือ **CHAT_ID**

### 2. Push ขึ้น GitHub

```bash
cd "~/Desktop/Bot Project/crypto_rsi_alert"
git add .
git commit -m "init"
gh repo create crypto-rsi-alert --private --source=. --push
```

(หรือสร้าง repo ผ่านเว็บ แล้ว `git remote add origin ... && git push -u origin main`)

### 3. ใส่ Secrets

GitHub repo → **Settings → Secrets and variables → Actions → New repository secret** เพิ่ม 2 ตัว:

- `BOT_TOKEN` = token จากข้อ 1
- `CHAT_ID` = chat id จากข้อ 1

### 4. เปิด Actions

- ไปที่ **Actions** tab → enable workflows
- ทดสอบ: เลือก workflow `RSI Alert` → **Run workflow** → ดูผลใน log

## Local dry-run (ไม่ส่ง Telegram จริง)

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
DRY_RUN=1 python scan.py
```

## Config (แก้ใน `scan.py`)

| ตัวแปร | Default | หมายถึง |
|---|---|---|
| `RSI_PERIOD` | 14 | period RSI |
| `LEVEL_OVERBOUGHT` | 70 | threshold ระดับ 1 |
| `LEVEL_EXTREME` | 80 | threshold ระดับ 2 |

State reset อัตโนมัติเมื่อ UTC date เปลี่ยน (ดู `load_state()` ใน `scan.py`)

---

# Watchlist Alert (Phase 1)

แจ้งเตือน price/funding triggers ของ ticker ที่เลือกไว้ — รันทุก **10 นาที** บน GitHub Actions รองรับหลาย exchange

## รองรับ Exchanges
- `binance_futures` — Binance USDT-M perpetual
- `binance_spot` — Binance spot
- `gateio_futures` — Gate.io USDT perpetual (เช่น BEAT_USDT)

## Trigger ที่รองรับ

| Trigger | เกิดเมื่อ |
|---------|----------|
| `price_breakout` | ราคา cross ขึ้นเหนือ `breakout_above` |
| `price_rejection` | ราคา cross ลงต่ำกว่า `rejection_below` |
| `support_break` | ราคา cross ลงต่ำกว่า `support_strong` |
| `resistance_test` | ราคา cross ขึ้นแตะ `resistance` (auto-on ถ้ามีค่า) |
| `funding_high` | abs(funding rate) ≥ threshold (เช่น 0.10%) |

แต่ละ trigger มี **cooldown 30 นาที** (กัน spam)

## CLI Helper — `manage_watchlist.py`

```bash
# ดู watchlist ทั้งหมด
python manage_watchlist.py list

# ดูรายละเอียด ticker
python manage_watchlist.py show BEAT_USDT

# เพิ่ม ticker
python manage_watchlist.py add DOGEUSDT \
  --exchange binance_futures \
  --breakout 0.25 \
  --rejection 0.18 \
  --support 0.15 \
  --funding 0.10

# แก้ไข level (เฉพาะ field ที่ระบุ)
python manage_watchlist.py set BEAT_USDT --rejection 4.05

# ปิด/เปิด ticker (เก็บ config ไว้)
python manage_watchlist.py disable EPICUSDT
python manage_watchlist.py enable EPICUSDT

# ลบ ticker
python manage_watchlist.py remove DOGEUSDT  # หรือ rm

# หยุดทั้งระบบ / กลับมาทำงาน
python manage_watchlist.py pause
python manage_watchlist.py resume
```

### Short flags
| Long | Short |
|------|-------|
| `--exchange` | `-e` |
| `--breakout` | `-b` |
| `--resistance` | `-r` |
| `--rejection` | `-j` |
| `--support` | `-s` |
| `--extreme` | `-x` |
| `--funding` | `-f` |

หลัง add/set/remove **ต้อง `git commit + push`** เพื่อให้ workflow ใช้ค่าใหม่

## แก้ Watchlist (manual)

หรือแก้ `watchlist.json` ตรงๆ แล้ว commit:

```json
{
  "settings": {
    "cooldown_minutes": 30,
    "enabled": true
  },
  "tickers": {
    "BEAT_USDT": {
      "exchange": "gateio_futures",
      "enabled": true,
      "levels": {
        "breakout_above": 4.30,
        "resistance": 4.24,
        "rejection_below": 4.00,
        "support_strong": 3.41
      },
      "alerts": {
        "price_breakout": true,
        "price_rejection": true,
        "support_break": true,
        "funding_high": 0.10
      }
    }
  }
}
```

### ปิดการทำงาน
- ทั้งระบบ: `"settings.enabled": false`
- เฉพาะ ticker: `"enabled": false` ใน ticker นั้น
- ลบ ticker: ลบ key ออกจาก `tickers` ทั้งหมด

## Local dry-run

```bash
source .venv/bin/activate
DRY_RUN=1 python watchlist_scan.py
```

## Cron Note

Cron ทำงานทุก 10 นาที (`*/10 * * * *`) = ~4,320 runs/เดือน
- **Public repo**: ฟรี ไม่จำกัด
- **Private repo**: ใกล้เคียง 2,000 มิน free tier — อาจต้องปรับเป็น `*/15` หรือ `*/30` ถ้าเกิน
