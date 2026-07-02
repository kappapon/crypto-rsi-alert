"""Pattern snapshot — จัด pattern รายเหรียญใน watchlist จากแท่ง daily.

Port ของ classifyPattern ใน dashboard/dashboard.js (กติกา+ลำดับต้องตรงกันเสมอ):
Parabolic > Breakout > Pullback > Downtrend > Range บน 50 แท่งท้าย (รวมแท่งวันนี้
แบบเดียวกับ dashboard). เขียน pattern_snapshot.json:
  patterns       — pattern ปัจจุบันต่อ symbol (key ตาม watchlist)
  parabolic_seen — วันล่าสุดที่เห็น Parabolic ต่อ base symbol (สะสม, เก็บ 60 วัน)
                   ให้ divmanage/worker โชว์ "เคย parabolic"

รันใน rsi-alert.yml ทุก 4 ชม. หลัง scan.py

Usage:
    python3 pattern_scan.py              # เขียนไฟล์
    DRY_RUN=1 python3 pattern_scan.py    # print อย่างเดียว
"""
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

from fetch_data import fetch_binance_klines, fetch_gate_futures_candles
from manage_watchlist import load_config

ROOT = Path(__file__).parent
OUT_FILE = ROOT / "pattern_snapshot.json"
DAY = 86400
BARS = 50            # ตรง dashboard fetchDailyOHLC limit=50
KEEP_SEEN_DAYS = 60  # ประวัติ parabolic เก็บนานแค่ไหน
DRY_RUN = os.environ.get("DRY_RUN") == "1"


def ema_last(vals: list[float], period: int) -> float:
    """EMA แบบ dashboard.js: seed ที่ค่าแรก แล้ววนทั้ง series คืนค่าสุดท้าย."""
    k = 2 / (period + 1)
    e = vals[0]
    for v in vals[1:]:
        e = v * k + e * (1 - k)
    return e


def classify(opens: list[float], highs: list[float], closes: list[float]) -> str | None:
    if len(closes) < BARS:
        return None
    n = len(closes)
    ema20 = ema_last(closes, 20)
    ema50 = ema_last(closes, 50)
    last = closes[-1]
    green_in4 = sum(1 for i in range(1, 5) if closes[n - i] > opens[n - i])
    if last > ema20 * 1.15 and green_in4 >= 3:
        return "Parabolic"
    high20 = max(highs[n - 21:n - 1])
    if last > high20:
        return "Breakout"
    red_in3 = sum(1 for i in range(1, 4) if closes[n - i] < opens[n - i])
    if last > ema50 and red_in3 >= 2:
        return "Pullback"
    if last < ema50 and ema20 < ema50:
        return "Downtrend"
    return "Range"


def fetch_daily(symbol: str, exchange: str):
    start = int(time.time()) - (BARS + 20) * DAY
    if exchange == "gateio_futures":
        return fetch_gate_futures_candles(symbol, "1d", start)
    return fetch_binance_klines(symbol.replace("_", ""), "1d", start)


def main() -> None:
    tickers = load_config().get("tickers", {})
    old = {}
    if OUT_FILE.exists():
        try:
            old = json.loads(OUT_FILE.read_text())
        except json.JSONDecodeError:
            pass

    today = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    patterns: dict[str, str] = {}
    seen: dict[str, str] = old.get("parabolic_seen", {})

    for sym, cfg in tickers.items():
        if not cfg.get("enabled", True):
            continue
        try:
            df = fetch_daily(sym, cfg["exchange"])
        except Exception as e:
            print(f"  {sym}: fetch error {e} — skip", file=sys.stderr)
            continue
        if df.empty or len(df) < BARS:
            print(f"  {sym}: ข้อมูลไม่พอ ({len(df)} แท่ง) — skip")
            continue
        tail = df.tail(BARS)
        name = classify(list(tail["open"]), list(tail["high"]), list(tail["close"]))
        if name is None:
            continue
        patterns[sym] = name
        if name == "Parabolic":
            seen[sym.replace("_", "").removesuffix("USDT")] = today
        print(f"  {sym}: {name}")

    # prune ประวัติเก่าเกิน KEEP_SEEN_DAYS
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=KEEP_SEEN_DAYS)).strftime("%Y-%m-%d")
    seen = {k: v for k, v in seen.items() if v >= cutoff}

    out = {
        "date": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "patterns": patterns,
        "parabolic_seen": seen,
    }
    counts: dict[str, int] = {}
    for v in patterns.values():
        counts[v] = counts.get(v, 0) + 1
    print(f"summary: {len(patterns)} classified {counts} | parabolic_seen {len(seen)}")
    if DRY_RUN:
        print("[DRY_RUN] no write")
        return
    OUT_FILE.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n")
    print(f"wrote {OUT_FILE.name}")


if __name__ == "__main__":
    main()
