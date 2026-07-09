"""Phase G — track paper trades recorded by reversal_scan.py.

Daily after candle close: walk each open trade's 4h candles since entry,
close it when SL/TP is touched (both in one 4h bar -> SL, conservative)
or at market after HORIZON daily bars. Telegram message when trades close.

Also resolves Rule C blocked signals in blocked_trades.json the same way
(counterfactual journal — silent, no Telegram).

R accounting (short): risk = sl - entry (= SL_ATR x ATR), r = (entry - exit) / risk.

Usage:
    DRY_RUN=1 python3 track_trades.py    # local test — no Telegram, no file write
"""
import datetime as dt
import json
import sys
import time
from pathlib import Path

from build_features import HORIZON
from fetch_data import fetch_binance_klines, fetch_gate_futures_candles
from scan import DRY_RUN, send_telegram

PAPER_FILE = Path(__file__).parent / "paper_trades.json"
BLOCKED_FILE = Path(__file__).parent / "blocked_trades.json"
HOLD_SEC = HORIZON * 86400
BAR = 14400  # 4h
FEE_PCT_ROUNDTRIP = 0.003  # ต้องตรง backtest.py — taker 2 ขา + slippage, สัดส่วนของ notional


def fetch_4h(symbol: str, exchange: str, start_sec: int):
    if exchange == "gateio_futures":
        return fetch_gate_futures_candles(symbol, "4h", start_sec)
    return fetch_binance_klines(symbol, "4h", start_sec)


def resolve_trade(t: dict, now_sec: int) -> dict | None:
    """Returns closing fields, or None if still open."""
    opened = int(dt.datetime.fromisoformat(t["opened_at"]).timestamp())
    expiry = opened + HOLD_SEC
    risk = t["sl"] - t["entry"]
    df = fetch_4h(t["symbol"], t["exchange"], opened - BAR)
    if df.empty:
        return None
    # แท่งที่ทับช่วงถือไม้ (แท่งแรกคือแท่งที่ entry เกิดกลางแท่ง — ถ้าชนทั้งคู่ให้เป็น SL: conservative)
    df = df[(df["open_time"] + BAR > opened) & (df["open_time"] < expiry)]
    last_close = None
    for _, b in df.iterrows():
        hit_sl = b["high"] >= t["sl"]
        hit_tp = b["low"] <= t["tp"]
        if hit_sl:  # รวมเคสชนทั้งคู่ในแท่งเดียว
            exit_p, outcome = t["sl"], "sl"
        elif hit_tp:
            exit_p, outcome = t["tp"], "tp"
        else:
            last_close = b["close"]
            continue
        closed_at = int(b["open_time"]) + BAR
        r = (t["entry"] - exit_p) / risk
        return {"status": f"closed_{outcome}", "exit": exit_p,
                "closed_at": dt.datetime.fromtimestamp(closed_at, dt.timezone.utc).isoformat(timespec="seconds"),
                "r": round(r, 3),
                "r_net": round(r - FEE_PCT_ROUNDTRIP * t["entry"] / risk, 3)}
    if now_sec >= expiry and last_close is not None:
        r = (t["entry"] - float(last_close)) / risk
        return {"status": "closed_expiry", "exit": float(last_close),
                "closed_at": dt.datetime.fromtimestamp(expiry, dt.timezone.utc).isoformat(timespec="seconds"),
                "r": round(r, 3),
                "r_net": round(r - FEE_PCT_ROUNDTRIP * t["entry"] / risk, 3)}
    return None


def track_blocked(now_sec: int) -> None:
    """Rule C counterfactual: resolve blocked signals ด้วยกลไกเดียวกับไม้จริง (เงียบ ไม่ส่ง Telegram).
    status: blocked -> cf_sl / cf_tp / cf_expiry (คนละ prefix กับไม้จริง — กันโดนนับปนใน journal อื่น)"""
    if not BLOCKED_FILE.exists():
        return
    book = json.loads(BLOCKED_FILE.read_text())
    trades = book.get("trades", [])
    pending = [t for t in trades if t["status"] == "blocked"]
    changed = 0
    for t in pending:
        try:
            res = resolve_trade({**t, "opened_at": t["blocked_at"]}, now_sec)
        except Exception as e:
            print(f"  blocked {t['symbol']}: track error {e}", file=sys.stderr)
            continue
        if res:
            res["status"] = res["status"].replace("closed_", "cf_")
            t.update(res)
            changed += 1
            print(f"  blocked {t['symbol']}: {t['status']} r={t['r']:+.2f} (counterfactual)")
        else:
            print(f"  blocked {t['symbol']}: still pending")
    done = [t for t in trades if t["status"].startswith("cf_")]
    if done:
        saved = -sum(t.get("r_net", t.get("r", 0)) for t in done)
        would_sl = sum(1 for t in done if t["status"] == "cf_sl")
        print(f"counterfactual: {len(done)} resolved ({would_sl} would-SL) — Rule C saved {saved:+.2f}R net")
    if changed and not DRY_RUN:
        BLOCKED_FILE.write_text(json.dumps(book, indent=2, sort_keys=True) + "\n")


def main() -> None:
    if not PAPER_FILE.exists():
        print("no paper_trades.json — nothing to track")
        return
    book = json.loads(PAPER_FILE.read_text())
    trades = book.get("trades", [])
    open_trades = [t for t in trades if t["status"] == "open"]
    print(f"trades: {len(trades)} total, {len(open_trades)} open")

    now_sec = int(time.time())
    newly_closed = []
    for t in open_trades:
        try:
            res = resolve_trade(t, now_sec)
        except Exception as e:
            print(f"  {t['symbol']}: track error {e}", file=sys.stderr)
            continue
        if res:
            t.update(res)
            newly_closed.append(t)
            print(f"  {t['symbol']}: {t['status']} r={t['r']:+.2f}")
        else:
            print(f"  {t['symbol']}: still open")

    closed = [t for t in trades if t["status"] != "open"]
    sum_r = sum(t.get("r", 0) for t in closed)
    sum_r_net = sum(t.get("r_net", t.get("r", 0)) for t in closed)
    hits = sum(1 for t in closed if t.get("r", 0) > 0)

    if newly_closed:
        lines = ["<b>📒 Paper trades — ไม้ปิดวันนี้</b>", ""]
        for t in newly_closed:
            emoji = {"closed_tp": "✅", "closed_sl": "❌", "closed_expiry": "⏰"}[t["status"]]
            lines.append(f"{emoji} <code>{t['symbol']}</code>  {t['status'].removeprefix('closed_').upper()}  "
                         f"r {t['r']:+.2f} (net {t['r_net']:+.2f})  (เข้า {t['entry']:g} → ออก {t['exit']:g})")
        lines.append("")
        lines.append(f"สะสม: {len(closed)} ไม้ปิด · hit {hits}/{len(closed)} · รวม {sum_r:+.2f}R (net {sum_r_net:+.2f}R) · เปิดอยู่ {len(open_trades) - len(newly_closed)}")
        send_telegram("\n".join(lines))

    print(f"summary: closed {len(closed)} (hit {hits}) sum {sum_r:+.2f}R net {sum_r_net:+.2f}R, open {len(open_trades) - len(newly_closed)}")
    if not DRY_RUN:
        PAPER_FILE.write_text(json.dumps(book, indent=2, sort_keys=True) + "\n")
    track_blocked(now_sec)
    print("done")


if __name__ == "__main__":
    main()
