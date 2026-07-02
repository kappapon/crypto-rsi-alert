"""Auto-evict เหรียญที่ "หมดรอบ" ออกจาก watchlist.

เงื่อนไขลบ (ครบทั้งคู่):
  1. RSI(14) daily แท่งปิด < EVICT_RSI_BELOW ติดกัน EVICT_CONSEC_DAYS วัน
     (deadband จาก entry 70 → ไม่ churn; ใช้แท่งปิดเลี่ยง whipsaw)
  2. journal เคลียร์ — ไม่มี trigger event ที่ยัง pending และไม่มี paper trade ที่ยัง open
     สำหรับเหรียญนั้น (รับประกัน "วิ่งจนจบ" สถิติไม่ถูกตัด)

เหรียญที่ออก ถ้า RSI กลับขึ้น ≥70 ปุ่ม ➕ จะ re-add สดใหม่ (enabled:true) ตาม fade-the-top cycle.

Usage:
    python3 auto_evict.py            # ลบจริง + commit ทำใน workflow
    DRY_RUN=1 python3 auto_evict.py  # print เฉย ๆ ไม่เขียนไฟล์ ไม่ส่ง Telegram
"""
import json
import sys
import time
from pathlib import Path

from build_features import wilder_rsi
from fetch_data import fetch_binance_klines, fetch_gate_futures_candles
from manage_watchlist import load_config, save_config
from scan import DRY_RUN, send_telegram

ROOT = Path(__file__).parent
TRIGGER_LOG = ROOT / "trigger_log.json"
PAPER_FILE = ROOT / "paper_trades.json"
EVICT_RSI_BELOW = 50.0
EVICT_CONSEC_DAYS = 1  # เดิม 2 — user ขอไวขึ้น 2026-07-02 (watchlist โตเร็ว เอาตัวเย็นออกเร็ว)
DAY = 86400
RSI_PERIOD = 14


def _load(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return {}


def fetch_daily_rsi_tail(symbol: str, exchange: str) -> list[float] | None:
    """Wilder RSI(14) ของแท่งปิดล่าสุด — คืน list ค่า RSI (ตาม time) หรือ None ถ้าข้อมูลไม่พอ."""
    start = time.time() - 60 * DAY
    if exchange == "gateio_futures":
        df = fetch_gate_futures_candles(symbol, "1d", int(start))
    else:
        df = fetch_binance_klines(symbol.replace("_", ""), "1d", int(start))
    if df.empty or len(df) < RSI_PERIOD + EVICT_CONSEC_DAYS + 1:
        return None
    rsi = wilder_rsi(df["close"]).dropna()
    if len(rsi) < EVICT_CONSEC_DAYS:
        return None
    return [float(x) for x in rsi]


def main() -> None:
    config = load_config()
    tickers = config.get("tickers", {})
    trigger_events = _load(TRIGGER_LOG).get("events", [])
    paper_trades = _load(PAPER_FILE).get("trades", [])

    busy_pending = {e["symbol"] for e in trigger_events if e.get("status") == "pending"}
    busy_open = {t["symbol"] for t in paper_trades if t.get("status") == "open"}
    busy = busy_pending | busy_open

    evicted: list[tuple[str, float]] = []
    for sym, cfg in list(tickers.items()):
        if not cfg.get("enabled", True):
            continue
        if sym in busy:
            print(f"  {sym}: skip — journal ยังไม่จบ (pending/open)")
            continue
        try:
            rsi_tail = fetch_daily_rsi_tail(sym, cfg["exchange"])
        except Exception as e:
            print(f"  {sym}: fetch error {e} — skip", file=sys.stderr)
            continue
        if rsi_tail is None:
            print(f"  {sym}: ข้อมูลไม่พอ — skip")
            continue
        last = rsi_tail[-EVICT_CONSEC_DAYS:]
        if all(r < EVICT_RSI_BELOW for r in last):
            del config["tickers"][sym]
            evicted.append((sym, last[-1]))
            print(f"  {sym}: EVICT — RSI {EVICT_CONSEC_DAYS} วันปิด < {EVICT_RSI_BELOW:g} "
                  f"({', '.join(f'{r:.1f}' for r in last)})")
        else:
            print(f"  {sym}: keep — RSI {last[-1]:.1f}")

    if not evicted:
        print("ไม่มีเหรียญเข้าเงื่อนไข evict")
        return

    lines = ["🧹 <b>ออกจาก watchlist อัตโนมัติ</b>",
             f"<i>RSI {EVICT_CONSEC_DAYS} วันปิด &lt; {EVICT_RSI_BELOW:g} + journal เคลียร์</i>", ""]
    lines += [f"  <code>{sym}</code>  RSI {rsi:.1f}" for sym, rsi in evicted]

    if DRY_RUN:
        print("[DRY_RUN] would evict:", [s for s, _ in evicted], "— no write, no Telegram")
        print("\n".join(lines))
        return

    save_config(config)
    send_telegram("\n".join(lines))
    print(f"evicted {len(evicted)}: {[s for s, _ in evicted]}")


if __name__ == "__main__":
    main()
