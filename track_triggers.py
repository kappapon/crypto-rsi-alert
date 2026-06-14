"""Score watchlist triggers logged by watchlist_scan.py — เชื่อถือได้แค่ไหน?

แต่ละ trigger (rejection / support_break / breakout / resistance_test / funding) ถูกบันทึก
ลง trigger_log.json พร้อมราคา ณ จุด trigger. สคริปต์นี้ตัดสินผลด้วย triple-barrier
เดียวกับ ML reversal model เพื่อเทียบ apples-to-apples:

  entry = ราคา ณ trigger | ATR = wilder_atr(14) ของแท่งวันที่ปิดล่าสุดก่อน trigger
  short: TP = entry − 2×ATR (win) / SL = entry + 1×ATR (loss)
  long : TP = entry + 2×ATR (win) / SL = entry − 1×ATR (loss)
  horizon = 10 วัน, ชนทั้งคู่ในแท่งเดียว = SL (conservative), หมดเวลา = ปิดราคาตลาด

R (short) = (entry − exit) / (sl − entry) ; (long) = (exit − entry) / (entry − sl)

สรุปสถิติ hit-rate + avg R ต่อ trigger type → trigger_stats.json (สำหรับ dashboard)

Usage:
    python3 track_triggers.py            # resolve + เขียนผลกลับ
    DRY_RUN=1 python3 track_triggers.py  # ไม่เขียนไฟล์ (ทดสอบ)
"""
import datetime as dt
import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

from build_features import HORIZON, wilder_atr
from fetch_data import fetch_binance_klines, fetch_gate_futures_candles
from train_model import SL_ATR, TP_ATR

LOG_FILE = Path(__file__).parent / "trigger_log.json"
STATS_FILE = Path(__file__).parent / "trigger_stats.json"
DRY_RUN = os.environ.get("DRY_RUN") == "1"
DAY = 86400
BAR = 14400  # 4h
HOLD_SEC = HORIZON * DAY


def _to_binance(symbol: str) -> str:
    return symbol.replace("_", "")


def fetch_daily(symbol: str, exchange: str, start_sec: int):
    if exchange == "gateio_futures":
        return fetch_gate_futures_candles(symbol, "1d", start_sec)
    return fetch_binance_klines(_to_binance(symbol), "1d", start_sec)


def fetch_4h(symbol: str, exchange: str, start_sec: int):
    if exchange == "gateio_futures":
        return fetch_gate_futures_candles(symbol, "4h", start_sec)
    return fetch_binance_klines(_to_binance(symbol), "4h", start_sec)


def atr_at(symbol: str, exchange: str, trigger_sec: int) -> float | None:
    """Wilder ATR(14) of the last daily bar closed before the trigger."""
    df = fetch_daily(symbol, exchange, trigger_sec - 40 * DAY)
    if df.empty or len(df) < 15:
        return None
    df = df.assign(atr=wilder_atr(df))
    closed = df[df["open_time"] + DAY <= trigger_sec]
    if closed.empty or closed["atr"].isna().all():
        return None
    val = closed["atr"].iloc[-1]
    return None if val != val else float(val)  # NaN guard


def resolve_event(e: dict, now_sec: int) -> dict | None:
    """Returns closing fields, or None if still open / not yet scorable."""
    trigger_sec = int(dt.datetime.fromisoformat(e["ts"]).timestamp())
    atr = atr_at(e["symbol"], e["exchange"], trigger_sec)
    if not atr:
        return None

    entry = e["price"]
    short = e["direction"] == "short"
    if short:
        tp, sl = entry - TP_ATR * atr, entry + SL_ATR * atr
        risk = sl - entry
    else:
        tp, sl = entry + TP_ATR * atr, entry - SL_ATR * atr
        risk = entry - sl

    expiry = trigger_sec + HOLD_SEC
    df = fetch_4h(e["symbol"], e["exchange"], trigger_sec - BAR)
    if df.empty:
        return None
    df = df[(df["open_time"] + BAR > trigger_sec) & (df["open_time"] < expiry)]

    last_close = None
    for _, b in df.iterrows():
        if short:
            hit_sl, hit_tp = b["high"] >= sl, b["low"] <= tp
        else:
            hit_sl, hit_tp = b["low"] <= sl, b["high"] >= tp
        if hit_sl:  # ชนทั้งคู่ในแท่งเดียว -> SL (conservative)
            exit_p, outcome = sl, "sl"
        elif hit_tp:
            exit_p, outcome = tp, "tp"
        else:
            last_close = b["close"]
            continue
        closed_at = int(b["open_time"]) + BAR
        r = (entry - exit_p) / risk if short else (exit_p - entry) / risk
        return {"status": f"closed_{outcome}", "atr": atr, "sl": sl, "tp": tp,
                "exit": exit_p, "r": round(r, 3),
                "closed_at": dt.datetime.fromtimestamp(closed_at, dt.timezone.utc).isoformat(timespec="seconds")}

    if now_sec >= expiry and last_close is not None:
        r = (entry - last_close) / risk if short else (last_close - entry) / risk
        return {"status": "closed_expiry", "atr": atr, "sl": sl, "tp": tp,
                "exit": float(last_close), "r": round(r, 3),
                "closed_at": dt.datetime.fromtimestamp(expiry, dt.timezone.utc).isoformat(timespec="seconds")}
    return None


def build_stats(events: list) -> dict:
    """hit-rate + avg R per trigger type (closed events only)."""
    by_type: dict[str, list] = defaultdict(list)
    for e in events:
        if e["status"].startswith("closed_"):
            by_type[e["type"]].append(e)

    per_type = {}
    for t, evs in sorted(by_type.items()):
        rs = [e["r"] for e in evs]
        wins = sum(1 for r in rs if r > 0)
        per_type[t] = {
            "n": len(evs),
            "hit_rate": round(wins / len(evs), 3),
            "avg_r": round(sum(rs) / len(rs), 3),
            "sum_r": round(sum(rs), 2),
            "tp": sum(1 for e in evs if e["status"] == "closed_tp"),
            "sl": sum(1 for e in evs if e["status"] == "closed_sl"),
            "expiry": sum(1 for e in evs if e["status"] == "closed_expiry"),
        }

    all_closed = [e for e in events if e["status"].startswith("closed_")]
    all_rs = [e["r"] for e in all_closed]
    overall = {
        "n": len(all_closed),
        "hit_rate": round(sum(1 for r in all_rs if r > 0) / len(all_rs), 3) if all_rs else 0,
        "avg_r": round(sum(all_rs) / len(all_rs), 3) if all_rs else 0,
        "pending": sum(1 for e in events if e["status"] == "pending"),
    }
    return {"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "overall": overall, "per_type": per_type}


def main() -> None:
    if not LOG_FILE.exists():
        print("no trigger_log.json — nothing to score")
        return
    log = json.loads(LOG_FILE.read_text())
    events = log.get("events", [])
    pending = [e for e in events if e["status"] == "pending"]
    print(f"events: {len(events)} total, {len(pending)} pending")

    now_sec = int(time.time())
    newly_closed = 0
    for e in pending:
        try:
            res = resolve_event(e, now_sec)
        except Exception as ex:
            print(f"  {e['symbol']}/{e['type']}: error {ex}", file=sys.stderr)
            continue
        if res:
            e.update(res)
            newly_closed += 1
            print(f"  {e['symbol']}/{e['type']} ({e['direction']}): {e['status']} r={e['r']:+.2f}")
        else:
            print(f"  {e['symbol']}/{e['type']}: still open")

    stats = build_stats(events)
    print("\n=== Trigger reliability (closed only) ===")
    o = stats["overall"]
    print(f"overall: {o['n']} closed · hit {o['hit_rate']:.0%} · avg {o['avg_r']:+.3f}R · {o['pending']} pending")
    for t, s in stats["per_type"].items():
        print(f"  {t:16s} n={s['n']:3d}  hit {s['hit_rate']:.0%}  avg {s['avg_r']:+.3f}R  "
              f"(tp {s['tp']} / sl {s['sl']} / exp {s['expiry']})")

    if not DRY_RUN:
        LOG_FILE.write_text(json.dumps(log, indent=2, ensure_ascii=False) + "\n")
        STATS_FILE.write_text(json.dumps(stats, indent=2, ensure_ascii=False) + "\n")
        print(f"\nwrote trigger_log.json (+{newly_closed} closed) + trigger_stats.json")
    else:
        print(f"\n[DRY_RUN] would close {newly_closed} — no files written")


if __name__ == "__main__":
    main()
