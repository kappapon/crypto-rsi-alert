"""Phase F — daily reversal (fade-short) alert from the trained model.

Runs on GitHub Actions after the daily candle close:
1. Screen Binance USDT spot pairs + watchlist tickers for the event condition
   (daily RSI >= 70 now, or within EXIT_WINDOW bars after dropping back).
2. For each candidate, rebuild the exact training features (3y daily history so
   dist_ath etc. match training) and score with models/model.pkl.
3. prob >= tau -> Telegram alert with ATR-based SL/TP levels and a ➕ button.

State: reversal_state.json — one alert per symbol per UTC day.

Usage:
    DRY_RUN=1 python3 reversal_scan.py          # local test, no Telegram
"""
import datetime as dt
import json
import pickle
import sys
import time
from pathlib import Path

import pandas as pd
import requests

from build_features import EXIT_WINDOW, HORIZON, RSI_ENTRY, WARMUP, build_symbol_features, wilder_rsi
from fetch_data import BINANCE_BASE, GATE_BASE, fetch_binance_klines, fetch_gate_futures_candles
from scan import DRY_RUN, _build_keyboard, fetch_usdt_symbols, send_telegram
from train_model import SL_ATR, TP_ATR, tsa1_proba

ROOT = Path(__file__).parent
MODEL_FILE = ROOT / "models" / "model.pkl"
STATE_FILE = ROOT / "reversal_state.json"
WATCHLIST_FILE = ROOT / "watchlist.json"
PAPER_FILE = ROOT / "paper_trades.json"  # Phase G — สมุดไม้จำลอง (track โดย track_trades.py)
BLOCKED_FILE = ROOT / "blocked_trades.json"  # ไม้ที่กติกา entry บล็อก (rule: cooldown/concurrent — เก็บวัด counterfactual)

SCREEN_BARS = 100          # cheap 1-request screening window
HISTORY_YEARS = 3.0        # must match fetch_data default used for training
H4_YEARS = 0.3             # rsi_4h EWM is converged long before this
COOLDOWN_SEC = HORIZON * 86400  # Rule C: ห้าม re-short เหรียญเดิมภายใน 1 horizon หลังโดน stop-out

# Dump-stage instrumentation (retro 2026-07-14 บน 50 ไม้: เข้า "หลัง 0.236 แตก" avg +0.61R vs "ก่อนแตก" −0.05R)
# เก็บ label ลง record ทุกไม้เพื่อรอ forward proof — ไม่กรอง/ไม่เปลี่ยนพฤติกรรมเข้าไม้
STAGE_HIGH_LB = 45     # แท่งปิดท้ายสุดที่ใช้หา swing high ของขา pump
STAGE_LOW_LB = 60      # แท่งย้อนจาก swing high ที่ใช้หา swing low (ฐานก่อน pump)
STAGE_MIN_PUMP = 0.25  # (high−low)/low ต่ำกว่านี้ = ไม่มีโครง pump ให้วัด → "nopump"


def screen_klines_binance(symbol: str) -> pd.DataFrame:
    """One-request daily history for event screening (closed candles only)."""
    r = requests.get(
        f"{BINANCE_BASE}/api/v3/klines",
        params={"symbol": symbol, "interval": "1d", "limit": SCREEN_BARS},
        timeout=30,
    )
    r.raise_for_status()
    now_ms = int(time.time() * 1000)
    rows = [[k[0] // 1000, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])]
            for k in r.json() if k[6] < now_ms]
    return pd.DataFrame(rows, columns=["open_time", "open", "high", "low", "close", "volume"])


def is_event(daily: pd.DataFrame) -> bool:
    if len(daily) < WARMUP:
        return False
    rsi = wilder_rsi(daily["close"])
    recent = rsi.tail(EXIT_WINDOW + 1)
    return bool((recent >= RSI_ENTRY).any()) and pd.notna(rsi.iloc[-1])


def fetch_full(symbol: str, exchange: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    start_1d = int(time.time()) - int(HISTORY_YEARS * 365 * 86400)
    start_4h = int(time.time()) - int(H4_YEARS * 365 * 86400)
    if exchange == "gateio_futures":
        return (fetch_gate_futures_candles(symbol, "1d", start_1d),
                fetch_gate_futures_candles(symbol, "4h", start_4h))
    return (fetch_binance_klines(symbol, "1d", start_1d),
            fetch_binance_klines(symbol, "4h", start_4h))


def fetch_live_price(symbol: str, exchange: str) -> float | None:
    """ราคาสด ณ เวลาส่ง alert — ใช้เป็นจุดอ้างอิง SL/TP (ตรงกับ backtest ที่เข้า open แท่งใหม่)."""
    try:
        if exchange == "gateio_futures":
            arr = requests.get(f"{GATE_BASE}/futures/usdt/tickers",
                               params={"contract": symbol}, timeout=15).json()
            return float(arr[0]["last"]) if arr else None
        r = requests.get(f"{BINANCE_BASE}/api/v3/ticker/price",
                         params={"symbol": symbol}, timeout=15)
        r.raise_for_status()
        return float(r.json()["price"])
    except Exception:
        return None


def swing_anchors(daily: pd.DataFrame) -> tuple[float, float] | None:
    """Swing ของขา pump ล่าสุดจากแท่งปิดล้วน (no lookahead — นิยามเดียวกับ stage_retro 2026-07-14):
    high = max ใน STAGE_HIGH_LB แท่งท้าย, low = min ใน STAGE_LOW_LB แท่งย้อนจากแท่ง high (รวมตัวมันเอง)."""
    if len(daily) < 15:
        return None
    highs = daily["high"].to_numpy()
    lows = daily["low"].to_numpy()
    base = max(0, len(highs) - STAGE_HIGH_LB)
    hi_pos = base + int(highs[base:].argmax())
    hi = float(highs[hi_pos])
    lo = float(lows[max(0, hi_pos - STAGE_LOW_LB): hi_pos + 1].min())
    return (hi, lo) if hi > lo > 0 else None


def dump_stage(anchors: tuple[float, float] | None, entry: float) -> dict:
    """ตำแหน่ง entry บน fib ladder ของ swing — instrumentation อย่างเดียว ไม่ใช้กรองไม้.
    stage_frac = (high−entry)/(high−low): <0.236 = pre (ใกล้ยอด), ≥0.236 = โครงสร้างแรกแตกแล้ว."""
    if anchors is None:
        return {"stage": None, "stage_frac": None, "pump_pct": None}
    hi, lo = anchors
    pump = round((hi - lo) / lo, 4)
    frac = round((hi - entry) / (hi - lo), 4)
    if pump < STAGE_MIN_PUMP:
        stage = "nopump"
    else:
        stage = next(name for cut, name in [(0.236, "pre"), (0.382, "early"), (0.5, "mid"),
                                            (0.618, "deep"), (0.786, "late"), (float("inf"), "post")]
                     if frac < cut)
    return {"stage": stage, "stage_frac": frac, "pump_pct": pump}


def load_json_book(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            pass
    return {"trades": []}


def recent_stopout(symbol: str, now_sec: int, book: dict) -> dict | None:
    """Rule C: stop-out ล่าสุดของเหรียญนี้ที่ยังอยู่ในช่วง cooldown (มี = ห้าม re-short)."""
    best = None
    for t in book.get("trades", []):
        if t.get("symbol") != symbol or t.get("status") != "closed_sl":
            continue
        try:
            closed_sec = dt.datetime.fromisoformat(t["closed_at"]).timestamp()
        except (KeyError, ValueError):
            continue
        if now_sec - closed_sec < COOLDOWN_SEC and (best is None or closed_sec > best[0]):
            best = (closed_sec, t)
    return best[1] if best else None


def open_trade(symbol: str, book: dict) -> dict | None:
    """NC guard: ไม้ของเหรียญนี้ที่ยังเปิดอยู่ (มี = ห้ามเปิดซ้อน — กัน pyramid แบบ WIN 5 ไม้ −5.4R)."""
    for t in book.get("trades", []):
        if t.get("symbol") == symbol and t.get("status") == "open":
            return t
    return None


def apply_entry_rules(hits: list[dict], book: dict, now_sec: int) -> tuple[list[dict], list[dict]]:
    """แยก hits เป็น (taken, blocked) — NC ก่อน (ไม้เดิมยังเปิด) แล้วค่อย Rule C (cooldown หลัง SL).
    blocked_by = timestamp ของสิ่งที่ทำให้บล็อก (opened_at ของไม้ที่เปิดอยู่ / closed_at ของ stop-out)"""
    taken, blocked = [], []
    for h in hits:
        ot = open_trade(h["symbol"], book)
        if ot is not None:
            h["rule"], h["blocked_by"] = "concurrent", ot["opened_at"]
            blocked.append(h)
            continue
        so = recent_stopout(h["symbol"], now_sec, book)
        if so is not None:
            h["rule"], h["blocked_by"] = "cooldown", so["closed_at"]
            blocked.append(h)
            continue
        taken.append(h)
    return taken, blocked


def record_paper_trades(hits: list[dict], breadth: int) -> None:
    """Phase G: บันทึกทุก hit เป็นไม้จำลอง — ใช้วัดว่า edge มีจริงไหมก่อนใช้เงิน."""
    book = load_json_book(PAPER_FILE)
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    for h in hits:
        book["trades"].append({
            "symbol": h["symbol"], "exchange": h["exchange"], "status": "open",
            "opened_at": now_iso, "entry": h["entry"], "sl": h["sl"], "tp": h["tp"],
            "atr": h["atr"], "prob": round(h["prob"], 3), "entry_is_live": h["live"],
            "breadth": breadth,
            "stage": h.get("stage"), "stage_frac": h.get("stage_frac"), "pump_pct": h.get("pump_pct"),
        })
    PAPER_FILE.write_text(json.dumps(book, indent=2, sort_keys=True) + "\n")
    print(f"paper journal: recorded {len(hits)} trade(s)")


def record_blocked(blocked: list[dict], breadth: int) -> None:
    """log ไม้ที่กติกา entry บล็อก (rule: cooldown/concurrent) พร้อม entry/sl/tp เพื่อวัด counterfactual ภายหลัง."""
    log = load_json_book(BLOCKED_FILE)
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    for h in blocked:
        log["trades"].append({
            "symbol": h["symbol"], "exchange": h["exchange"], "status": "blocked",
            "blocked_at": now_iso, "blocked_by": h["blocked_by"], "rule": h["rule"],
            "entry": h["entry"], "sl": h["sl"], "tp": h["tp"], "atr": h["atr"],
            "prob": round(h["prob"], 3), "entry_is_live": h["live"], "breadth": breadth,
            "stage": h.get("stage"), "stage_frac": h.get("stage_frac"), "pump_pct": h.get("pump_pct"),
        })
    BLOCKED_FILE.write_text(json.dumps(log, indent=2, sort_keys=True) + "\n")
    print(f"blocked journal: recorded {len(blocked)} blocked signal(s)")


def load_state(today: str) -> dict:
    if STATE_FILE.exists():
        try:
            s = json.loads(STATE_FILE.read_text())
            if s.get("date") == today:
                return s
        except json.JSONDecodeError:
            pass
    return {"date": today, "alerted": []}


def main() -> None:
    today = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    print(f"[{today}] reversal scan start")
    with open(MODEL_FILE, "rb") as f:
        model = pickle.load(f)
    tau = model["tau"]
    print(f"model tau={tau}, features={len(model['features'])}")

    state = load_state(today)

    # --- screening ---
    candidates: list[tuple[str, str]] = []
    symbols = fetch_usdt_symbols()
    errors = 0
    for i, sym in enumerate(symbols, 1):
        try:
            if is_event(screen_klines_binance(sym)):
                candidates.append((sym, "binance_spot"))
        except Exception as e:
            errors += 1
            print(f"  screen {sym}: {e}", file=sys.stderr)
        if i % 100 == 0:
            print(f"  screened {i}/{len(symbols)}")

    watchlist = json.loads(WATCHLIST_FILE.read_text()).get("tickers", {}) if WATCHLIST_FILE.exists() else {}
    for sym, cfg in watchlist.items():
        if not cfg.get("enabled", True) or any(sym == c[0] for c in candidates):
            continue
        try:
            ex = cfg.get("exchange", "binance_spot")
            daily = (fetch_gate_futures_candles(sym, "1d", int(time.time()) - SCREEN_BARS * 86400)
                     if ex == "gateio_futures" else screen_klines_binance(sym))
            if is_event(daily):
                candidates.append((sym, ex))
        except Exception as e:
            errors += 1
            print(f"  screen watchlist {sym}: {e}", file=sys.stderr)
    print(f"candidates: {len(candidates)} (screen errors: {errors})")

    # --- scoring ---
    btc = fetch_binance_klines("BTCUSDT", "1d", int(time.time()) - int(HISTORY_YEARS * 365 * 86400))
    hits = []
    for sym, ex in candidates:
        try:
            daily, h4 = fetch_full(sym, ex)
            if len(daily) < WARMUP:
                continue
            feat = build_symbol_features(daily, h4, btc)
            x = feat[model["features"]].iloc[[-1]]
            prob = float(tsa1_proba(model["learners"], model["dropped"], x)[0])
            row = feat.iloc[-1]
            print(f"  {sym}: prob={prob:.3f} rsi={row['rsi']:.1f}")
            if prob >= tau and sym not in state["alerted"]:
                hits.append({"symbol": sym, "exchange": ex, "prob": prob, "rsi": row["rsi"],
                             "close": row["close"], "atr": row["atr"],
                             "anchors": swing_anchors(daily)})
        except Exception as e:
            errors += 1
            print(f"  score {sym}: {e}", file=sys.stderr)

    print(f"hits: {len(hits)} (already alerted today: {len(state['alerted'])})")
    if hits:
        hits.sort(key=lambda h: -h["prob"])
        for h in hits:
            # SL/TP ยึดราคาสด (= "เข้า open แท่งถัดไป" ตาม backtest); ATR จากแท่งปิดเหมือนตอน train
            live = fetch_live_price(h["symbol"], h["exchange"])
            h["entry"] = live if live is not None else h["close"]
            h["live"] = live is not None
            h["sl"] = h["entry"] + SL_ATR * h["atr"]
            h["tp"] = h["entry"] - TP_ATR * h["atr"]
            h.update(dump_stage(h.pop("anchors"), h["entry"]))
        print("stage: " + ", ".join(
            f"{h['symbol']} {h['stage'] or '?'}" +
            (f"({h['stage_frac']:+.0%})" if h["stage_frac"] is not None else "")
            for h in hits))

        # breadth = จำนวนสัญญาณวันนี้ (ก่อนกรอง cooldown) — วัดสภาพตลาด ไม่ใช่จำนวนไม้ที่เข้าจริง
        breadth = len(hits)

        # กติกา entry: NC (ห้ามเปิดซ้อนขณะไม้เดิมยังเปิด — leak: WIN pyramid 5 ไม้ −5.4R)
        # + Rule C (cooldown หลัง stop-out — leak: SYN โดน re-short 6 วันติด −6R)
        book = load_json_book(PAPER_FILE)
        now_sec = int(time.time())
        taken, blocked = apply_entry_rules(hits, book, now_sec)
        if blocked:
            tag = {"concurrent": "เปิดอยู่", "cooldown": "SL"}
            print("entry rules blocked: " + ", ".join(f"{h['symbol']}({tag[h['rule']]} {h['blocked_by'][:10]})" for h in blocked))
            if not DRY_RUN:
                record_blocked(blocked, breadth)

        state["alerted"].extend(h["symbol"] for h in hits)

        if taken:
            breadth_tag = " 🔥 วันฝูงใหญ่" if breadth >= 5 else ""
            lines = ["<b>🎯 Reversal watch — fade the top</b>",
                     f"model prob ≥ {tau} (เข้า short แท่งถัดไป, SL +{SL_ATR}×ATR / TP −{TP_ATR}×ATR)",
                     f"สัญญาณวันนี้: {breadth} ตัว{breadth_tag}", ""]
            for h in taken:
                stage_tag = (f" · {h['stage']} {h['stage_frac']:+.0%}"
                             if h.get("stage") and h["stage_frac"] is not None else "")
                lines.append(f"<code>{h['symbol']}</code>  prob {h['prob']:.0%} · RSI {h['rsi']:.0f}{stage_tag}")
                price_part = f"ราคาล่าสุด {h['entry']:g}" if h["live"] else f"ราคาปิดแท่ง {h['entry']:g} (ดึงราคาสดไม่ได้)"
                lines.append(f"   {price_part} · SL {h['sl']:g} · TP {h['tp']:g}")
            if blocked:
                reason = {"concurrent": "ไม้เดิมยังเปิด", "cooldown": "cooldown หลัง SL"}
                lines.append("")
                lines.append(f"🚫 ข้าม {len(blocked)} ตัว: " + ", ".join(f"{h['symbol']} ({reason[h['rule']]})" for h in blocked))
            lines.append("")
            lines.append("👇 กด ➕ เพื่อเพิ่มเข้า watchlist")
            send_telegram("\n".join(lines), reply_markup=_build_keyboard([h["symbol"] for h in taken]))
            if not DRY_RUN:
                record_paper_trades(taken, breadth)
        else:
            print("all hits blocked by entry rules — no alert sent")

    if not DRY_RUN:
        STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    print("done")


if __name__ == "__main__":
    main()
