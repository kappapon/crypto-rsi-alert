"""Score div-watch confirmed entries logged by divwatch_journal.py — เชื่อถือได้แค่ไหน?

ต่างจาก track_triggers.py ตรงที่สัญญาณนี้ไม่มี TP ทางการ (exit เป็น discretionary,
alert บอกแค่ "size ตาม stop นี้") — วัดด้วย MFE/MAE-in-R แทน triple-barrier:

  entry/stop = ค่าที่บันทึกไว้ตอน confirm แล้ว (ไม่ต้องคำนวณ ATR ใหม่)
  risk = stop − entry (short เสมอ)
  เดินแท่ง 15m (timeframe เดียวกับสัญญาณ) นับตั้งแต่ entry ถึง horizon:
    MAE_R = ส่วนเกินราคาสูงสุดที่ขยับสวนทาง (high) / risk, ถูก cap ที่ 1.0 ตอนโดน stop
    MFE_R = ระยะที่ราคาไหลลงได้ไกลสุด (low) / risk, นับเฉพาะ "ก่อน" โดน stop
    ชนทั้งคู่ในแท่งเดียว = stop (conservative เหมือน track_triggers/track_trades)
    หมดเวลา (horizon) = ปิดที่ราคาตลาด, terminal_r = mark-to-market
  hit_rate_2R (derived, ไม่ใช่ exit rule จริง) = MFE_R ≥ REF_K ก่อนโดน stop

ที่มา (ATR(15m) เดินแท่งหยาบไป — stop ของสัญญาณนี้มักแคบกว่า 2% เดินด้วยแท่ง 4h/daily
เหมือน track_triggers จะโดน "ชนทั้งคู่แท่งเดียว" แทบทุกไม้ ต้องเดินด้วยแท่ง 15m เท่านั้น)

symbol/source ที่ log ไว้พอสำหรับ fetch เอง ไม่ต้องอิง DIV_WATCH list สด (mutable ผ่าน dashboard)

Usage:
    python3 track_divwatch.py            # resolve + เขียนผลกลับ
    DRY_RUN=1 python3 track_divwatch.py  # ไม่เขียนไฟล์ (ทดสอบ)
"""
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

from fetch_data import fetch_binance_klines, fetch_gate_futures_candles

LOG_FILE = Path(__file__).parent / "divwatch_log.json"
STATS_FILE = Path(__file__).parent / "divwatch_stats.json"
DRY_RUN = os.environ.get("DRY_RUN") == "1"
BAR = 900  # 15m
HORIZON_H = 72
HORIZON_SEC = HORIZON_H * 3600
REF_K = 2.0  # derived reference R-multiple for hit_rate_2r — not an exit rule


def _to_binance(symbol: str) -> str:
    return symbol.replace("_", "")


def fetch_15m(symbol: str, source: str, start_sec: int):
    if source == "gate":
        return fetch_gate_futures_candles(symbol, "15m", start_sec)
    if source == "binance":
        return fetch_binance_klines(_to_binance(symbol), "15m", start_sec)
    return None  # gate_spot — no Python fetcher yet (0 symbols use it today)


def _iso(sec: int) -> str:
    return dt.datetime.fromtimestamp(sec, dt.timezone.utc).isoformat(timespec="seconds")


def resolve_event(e: dict, now_sec: int) -> dict | None:
    """Returns closing fields, or None if still open / not yet scorable."""
    entry_sec = int(dt.datetime.fromisoformat(e["ts"]).timestamp())
    entry, stop = e["entry"], e["stop"]
    risk = stop - entry
    expiry = entry_sec + HORIZON_SEC

    df = fetch_15m(e["symbol"], e["source"], entry_sec - BAR)
    if df is None or df.empty:
        return None
    df = df[(df["open_time"] + BAR > entry_sec) & (df["open_time"] < expiry)]

    mae_r, mfe_r = 0.0, 0.0
    last_close = None
    for _, b in df.iterrows():
        if b["high"] >= stop:  # ชนทั้งคู่ในแท่งเดียว -> stop (conservative), หยุดเดินต่อ
            mae_r = 1.0
            stop_ts = int(b["open_time"]) + BAR
            return {"status": "closed_sl", "mae_r": round(mae_r, 3), "mfe_r": round(mfe_r, 3),
                    "stopped": True, "stop_ts": _iso(stop_ts), "terminal_r": -1.0,
                    "exit": stop, "closed_at": _iso(stop_ts), "horizon_h": HORIZON_H}
        mae_r = max(mae_r, (b["high"] - entry) / risk)
        mfe_r = max(mfe_r, (entry - b["low"]) / risk)
        last_close = b["close"]

    if now_sec < expiry:
        return None  # ยังไม่ครบ horizon และไม่โดน stop — รอรอบหน้า
    if last_close is None:
        return None  # ยังไม่มีแท่งให้เดินเลย — รอรอบหน้า
    terminal_r = (entry - last_close) / risk
    return {"status": "closed_expiry", "mae_r": round(mae_r, 3), "mfe_r": round(mfe_r, 3),
            "stopped": False, "stop_ts": None, "terminal_r": round(terminal_r, 3),
            "exit": float(last_close), "closed_at": _iso(expiry), "horizon_h": HORIZON_H}


def _median(xs: list) -> float:
    if not xs:
        return 0.0
    xs = sorted(xs)
    n = len(xs)
    mid = n // 2
    return xs[mid] if n % 2 else (xs[mid - 1] + xs[mid]) / 2


def build_stats(events: list) -> dict:
    confirmed = [e for e in events if e.get("stage") == "confirmed"]
    closed = [e for e in confirmed if e["status"].startswith("closed_")]

    stop_n = sum(1 for e in closed if e["stopped"])
    hit2r_n = sum(1 for e in closed if e["mfe_r"] >= REF_K)
    terminal_rs = [e["terminal_r"] for e in closed]

    confirmed_stats = {
        "n": len(closed),
        "pending": sum(1 for e in confirmed if e["status"] == "pending"),
        "unscored": sum(1 for e in confirmed if e["status"] == "unscored_source"),
        "stop_rate": round(stop_n / len(closed), 3) if closed else 0,
        "median_mfe_r": round(_median([e["mfe_r"] for e in closed]), 3),
        "median_mae_r": round(_median([e["mae_r"] for e in closed]), 3),
        "avg_terminal_r": round(sum(terminal_rs) / len(terminal_rs), 3) if terminal_rs else 0,
        "hit_rate_2r": round(hit2r_n / len(closed), 3) if closed else 0,
    }

    armed_n = sum(1 for e in events if e.get("stage") == "armed")
    confirmed_n = len(confirmed)
    funnel = {
        "armed": armed_n,
        "confirmed": confirmed_n,
        "conversion": round(confirmed_n / armed_n, 3) if armed_n else 0,
        "flip": sum(1 for e in events if e.get("stage") == "flip"),
    }

    return {"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "confirmed": confirmed_stats, "funnel": funnel}


def main() -> None:
    if not LOG_FILE.exists():
        print("no divwatch_log.json — nothing to score")
        return
    log = json.loads(LOG_FILE.read_text())
    events = log.get("events", [])
    pending = [e for e in events if e.get("stage") == "confirmed" and e["status"] == "pending"]
    print(f"events: {len(events)} total, {len(pending)} confirmed pending")

    now_sec = int(time.time())
    newly_closed = 0
    for e in pending:
        if e.get("source") not in ("gate", "binance"):
            e["status"] = "unscored_source"
            print(f"  {e['symbol']}: unscored source {e.get('source')!r}")
            continue
        try:
            res = resolve_event(e, now_sec)
        except Exception as ex:
            print(f"  {e['symbol']}: error {ex}", file=sys.stderr)
            continue
        if res:
            e.update(res)
            newly_closed += 1
            print(f"  {e['symbol']}: {e['status']} terminal_r={e['terminal_r']:+.2f} "
                  f"mfe={e['mfe_r']:.2f} mae={e['mae_r']:.2f}")
        else:
            print(f"  {e['symbol']}: still open")

    stats = build_stats(events)
    print("\n=== Div-watch reliability (closed confirmed only) ===")
    c = stats["confirmed"]
    print(f"confirmed: {c['n']} closed · stop rate {c['stop_rate']:.0%} · "
          f"avg terminal {c['avg_terminal_r']:+.3f}R · median MFE {c['median_mfe_r']:.2f}R · "
          f"hit_2R {c['hit_rate_2r']:.0%} · {c['pending']} pending")
    f = stats["funnel"]
    print(f"funnel: armed {f['armed']} -> confirmed {f['confirmed']} "
          f"({f['conversion']:.0%}) · flip {f['flip']}")

    if not DRY_RUN:
        LOG_FILE.write_text(json.dumps(log, indent=2, ensure_ascii=False) + "\n")
        STATS_FILE.write_text(json.dumps(stats, indent=2, ensure_ascii=False) + "\n")
        print(f"\nwrote divwatch_log.json (+{newly_closed} closed) + divwatch_stats.json")
    else:
        print(f"\n[DRY_RUN] would close {newly_closed} — no files written")


if __name__ == "__main__":
    main()
