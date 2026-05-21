# Crypto RSI Alert

แจ้งเตือนผ่าน Telegram เมื่อคู่เหรียญ USDT บน Binance มี **Daily RSI(14) > 70** (overbought) หรือ **> 80** (extreme) — ตรวจวันละครั้ง รันบน GitHub Actions ฟรี

## How it works

- รัน cron `00:10 UTC` ทุกวัน (= 07:10 น. ไทย) — หลัง daily candle ของ Binance ปิด
- ดึง symbol USDT spot ที่ status TRADING ทั้งหมด (~400)
- คำนวณ RSI(14) แบบ Wilder (ตรงกับ TradingView) จาก candle ที่ปิดแล้วเท่านั้น
- Alert logic 2 ระดับ:
  - ⚠️ ข้าม 70 ขึ้น → แจ้งครั้งเดียว
  - 🚨 ข้าม 80 ขึ้น → แจ้งครั้งเดียว (เพิ่มเติมจาก 70)
  - RSI < 70 → reset (พร้อมแจ้งใหม่ได้)
- เก็บ state ใน `state.json` — workflow commit กลับเข้า repo เอง

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
| `RESET_BELOW` | 70 | RSI ต่ำกว่านี้ → reset state |
