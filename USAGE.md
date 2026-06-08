# คู่มือการใช้งาน — Crypto Alert Bot

คู่มือทีละขั้นตอนสำหรับการใช้งาน bot ทั้งสองตัว (RSI Alert + Watchlist Alert) ตั้งแต่ setup จนถึง alert ใน Telegram

---

## 📋 สารบัญ

1. [Setup ครั้งเดียว](#1-setup-ครั้งเดียว)
2. [เพิ่ม Ticker เข้า Watchlist](#2-เพิ่ม-ticker-เข้า-watchlist)
3. [ดู / แก้ไข / ปิด Ticker](#3-ดู--แก้ไข--ปิด-ticker)
4. [Activate โดย Commit + Push](#4-activate-โดย-commit--push)
5. [Telegram Alert ที่จะได้รับ](#5-telegram-alert-ที่จะได้รับ)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. Setup ครั้งเดียว

### 1.1 สร้าง Telegram Bot

1. เปิด Telegram → ค้น `@BotFather` → พิมพ์ `/newbot`
2. ตั้งชื่อ bot → ได้ **BOT_TOKEN** หน้าตา `123456:ABC-DEF...`
3. ส่งข้อความอะไรก็ได้ไปหา bot ที่สร้างใหม่
4. เปิด URL: `https://api.telegram.org/bot<TOKEN>/getUpdates`
5. หา `"chat":{"id": 123456789` → ตัวเลขนั้นคือ **CHAT_ID**

### 1.2 ใส่ Secrets ใน GitHub

GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|------|-------|
| `BOT_TOKEN` | จากข้อ 1.1 |
| `CHAT_ID` | จากข้อ 1.1 |

### 1.3 Enable Workflows

- ไปที่ **Actions** tab → enable workflows
- ทดสอบ: เลือก `RSI Alert` หรือ `Watchlist Alert` → **Run workflow** → ดู log

### 1.4 Clone + Setup Local (ถ้าจะใช้ CLI)

```bash
git clone <repo-url>
cd crypto_rsi_alert
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

---

## 2. เพิ่ม Ticker เข้า Watchlist

มี 2 วิธี — **Auto (แนะนำ)** หรือ **Manual**

### 2.1 วิธี Auto: ใช้ `suggest` (แนะนำ)

```bash
python manage_watchlist.py suggest BTCUSDT
```

Bot จะ:
1. Auto-detect exchange (Binance futures → spot → Gate.io)
2. ดึง 1H candles 500 แท่ง (~20 วัน)
3. คำนวณ:
   - **ATH** (resistance + breakout level)
   - **EMA20 / EMA50** (support_strong / support_extreme)
   - **Recent swing low** (rejection level)
4. แสดง suggested levels → ถาม `y/N`
5. ถ้า `y` → add เข้า `watchlist.json` ให้เลย

**ตัวอย่าง output:**
```
🔍 Analyzing BTCUSDT on binance_futures...
   Current:     65420.5
   ATH (1H):    68200  (last 500 candles ≈ 20d)

💡 Suggested levels:
   -e binance_futures
   -b 69223   (breakout = ATH +1.5%)
   -r 68200   (resistance = ATH)
   -j 64500   (rejection = recent swing low)
   -s 63100   (support_strong = EMA20 1H)
   -x 60800   (support_extreme = EMA50 1H)
   -f 0.1   (funding_high = standard 0.1%)

Add to watchlist? (y/N): y
✅ Added BTCUSDT (binance_futures)
```

### 2.2 วิธี Manual: ใช้ `add`

ถ้าอยากกำหนด levels เอง:

```bash
python manage_watchlist.py add DOGEUSDT \
  --exchange binance_futures \
  --breakout 0.25 \
  --rejection 0.18 \
  --support 0.15 \
  --funding 0.10
```

**Short flags:**

| Long | Short | Field |
|------|-------|-------|
| `--exchange` | `-e` | Exchange (binance_futures / binance_spot / gateio_futures) |
| `--breakout` | `-b` | breakout_above (LONG signal เมื่อทะลุ) |
| `--resistance` | `-r` | resistance (alert เมื่อแตะ) |
| `--rejection` | `-j` | rejection_below (SHORT signal เมื่อหลุด) |
| `--support` | `-s` | support_strong (alert เมื่อหลุด) |
| `--extreme` | `-x` | support_extreme (deep correction) |
| `--funding` | `-f` | funding rate threshold % |

---

## 3. ดู / แก้ไข / ปิด Ticker

### 3.1 ดูรายการ ticker ทั้งหมด

```bash
python manage_watchlist.py list
# หรือ
python manage_watchlist.py ls
```

**Output:**
```
🌐 Global: 🟢 ACTIVE
📋 Tickers (3):
   🟢 BEAT_USDT     [gateio_futures   ]  brea=4.30 | resi=4.24 | reje=4.00 | supp=3.41
   🟢 EPICUSDT      [binance_futures  ]  brea=2.50 | reje=1.80
   ⚫ ALLOUSDT      [binance_futures  ]  brea=0.85 (disabled)
```

### 3.2 ดูรายละเอียด ticker เดียว

```bash
python manage_watchlist.py show BEAT_USDT
```

### 3.3 แก้ไข level

```bash
# แก้เฉพาะ field ที่ระบุ — ที่เหลือคงเดิม
python manage_watchlist.py set BEAT_USDT --rejection 4.05
python manage_watchlist.py set BEAT_USDT -j 4.05 -b 4.32   # short flags
```

### 3.4 ปิด / เปิด ticker (เก็บ config ไว้)

```bash
python manage_watchlist.py disable EPICUSDT
python manage_watchlist.py enable EPICUSDT
```

### 3.5 ลบ ticker ออก

```bash
python manage_watchlist.py remove DOGEUSDT
# หรือ
python manage_watchlist.py rm DOGEUSDT
```

### 3.6 หยุด / กลับมาทำงาน ทั้งระบบ

```bash
python manage_watchlist.py pause    # หยุดทุก ticker
python manage_watchlist.py resume   # กลับมาทำงาน
```

> 💡 **Pause** ไม่ลบ config — แค่ทำให้ workflow skip ทุก ticker ในรอบถัดไป

---

## 4. Activate โดย Commit + Push

> ⚠️ **สำคัญ**: ทุกครั้งที่แก้ `watchlist.json` (ผ่าน CLI หรือ manual edit) **ต้อง commit + push** เพื่อให้ GitHub Actions workflow ใช้ค่าใหม่

```bash
git add watchlist.json
git commit -m "watchlist: add BTCUSDT"
git push
```

Workflow `Watchlist Alert` จะรันทุก 10 นาที — ค่าใหม่จะถูกใช้ในรอบถัดไป

### Local Dry-Run (ทดสอบก่อน commit)

```bash
source .venv/bin/activate
DRY_RUN=1 python watchlist_scan.py    # ไม่ส่ง Telegram จริง — แค่ print
```

---

## 5. Telegram Alert ที่จะได้รับ

### 5.1 RSI Alert (รายวัน)

ทุก 4 ชั่วโมง bot จะเช็คคู่ USDT spot ทั้งหมดบน Binance

```
🚨 BTCUSDT — RSI 72.5 (overbought)
🚨 ETHUSDT — RSI 81.3 (extreme!)
```

- `> 70` แจ้งครั้งเดียวต่อวัน
- `> 80` แจ้งเพิ่มอีกครั้ง
- Reset ที่ 00:00 UTC (07:00 ไทย)

### 5.2 Watchlist Alert (ทุก 10 นาที)

```
🚨 BEAT_USDT
💵 4.2845 (+92.03% 24h)
💰 Funding: +0.200% | Vol: $72.9M

⚡ BREAKOUT — ทะลุ 4.30 (LONG signal)
```

**ประเภท trigger:**

| Icon | Trigger | เกิดเมื่อ |
|------|---------|----------|
| ⚡ | `price_breakout` | ราคา cross ขึ้นเหนือ `breakout_above` |
| 🔻 | `price_rejection` | ราคา cross ลงต่ำกว่า `rejection_below` |
| 💥 | `support_break` | ราคา cross ลงต่ำกว่า `support_strong` |
| ⚠️ | `resistance_test` | ราคา cross ขึ้นแตะ `resistance` |
| 🔥 | `funding_high` | abs(funding rate) ≥ threshold |

แต่ละ trigger มี **cooldown 30 นาที** (กัน spam) — Configure ใน `watchlist.json`:

```json
{"settings": {"cooldown_minutes": 30}}
```

---

## 6. Troubleshooting

### 6.1 ไม่มี alert มา — เช็คอะไรบ้าง?

```bash
# 1. workflow ทำงานไหม?
gh run list --workflow="Watchlist Alert" --limit 5

# 2. Global enabled?
python manage_watchlist.py list   # ต้องขึ้น 🟢 ACTIVE

# 3. Ticker enabled?
python manage_watchlist.py show <SYM>   # "enabled": true

# 4. Local dry-run ดู logic
DRY_RUN=1 python watchlist_scan.py
```

### 6.2 ราคาผ่าน level แล้วแต่ไม่ alert

Cause: **cooldown** ยังไม่หมด (30 นาที per trigger key)

```bash
# Reset state — alert ใหม่ได้ทันที
echo '{"tickers": {}}' > watchlist_state.json
git add watchlist_state.json && git commit -m "reset state" && git push
```

### 6.3 Binance API HTTP 451 (Geo-restricted)

- RSI bot (`scan.py`) ใช้ `data-api.binance.vision` แทน `api.binance.com` แก้ปัญหา GitHub Actions runner ที่โดน geo-block
- Watchlist bot (`watchlist_scan.py`) ใช้ endpoint เดียวกัน

### 6.4 Private repo เกิน GitHub Actions free tier

Cron `*/10 * * * *` = ~4,320 runs/เดือน
- **Public repo**: ฟรี ไม่จำกัด
- **Private repo**: ~2,000 min free — ปรับเป็น `*/15` หรือ `*/30` ใน `.github/workflows/watchlist.yml`

### 6.5 `suggest` หา exchange ไม่เจอ

```bash
# ระบุ exchange เองได้
python manage_watchlist.py suggest BTCUSDT --exchange binance_spot
```

---

## 🎯 Workflow ทั่วไป (Cheat Sheet)

```bash
# 1. เพิ่ม ticker ใหม่ (auto-suggest)
python manage_watchlist.py suggest BTCUSDT

# 2. ดู status
python manage_watchlist.py list

# 3. แก้ level (ถ้าจำเป็น)
python manage_watchlist.py set BTCUSDT -j 64000

# 4. Activate
git add watchlist.json
git commit -m "watchlist: add BTCUSDT"
git push

# 5. รอ alert ใน Telegram (ทุก 10 นาที)
```

---

ดู [README.md](README.md) สำหรับ technical reference + config schema เต็ม
