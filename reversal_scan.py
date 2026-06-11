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

from build_features import EXIT_WINDOW, RSI_ENTRY, WARMUP, build_symbol_features, wilder_rsi
from fetch_data import BINANCE_BASE, GATE_BASE, fetch_binance_klines, fetch_gate_futures_candles
from scan import DRY_RUN, _build_keyboard, fetch_usdt_symbols, send_telegram
from train_model import SL_ATR, TP_ATR, tsa1_proba

ROOT = Path(__file__).parent
MODEL_FILE = ROOT / "models" / "model.pkl"
STATE_FILE = ROOT / "reversal_state.json"
WATCHLIST_FILE = ROOT / "watchlist.json"
PAPER_FILE = ROOT / "paper_trades.json"  # Phase G — สมุดไม้จำลอง (track โดย track_trades.py)

SCREEN_BARS = 100          # cheap 1-request screening window
HISTORY_YEARS = 3.0        # must match fetch_data default used for training
H4_YEARS = 0.3             # rsi_4h EWM is converged long before this


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


def record_paper_trades(hits: list[dict]) -> None:
    """Phase G: บันทึกทุก hit เป็นไม้จำลอง — ใช้วัดว่า edge มีจริงไหมก่อนใช้เงิน."""
    book = {"trades": []}
    if PAPER_FILE.exists():
        try:
            book = json.loads(PAPER_FILE.read_text())
        except json.JSONDecodeError:
            pass
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    for h in hits:
        book["trades"].append({
            "symbol": h["symbol"], "exchange": h["exchange"], "status": "open",
            "opened_at": now_iso, "entry": h["entry"], "sl": h["sl"], "tp": h["tp"],
            "atr": h["atr"], "prob": round(h["prob"], 3), "entry_is_live": h["live"],
            "breadth": len(hits),
        })
    PAPER_FILE.write_text(json.dumps(book, indent=2, sort_keys=True) + "\n")
    print(f"paper journal: recorded {len(hits)} trade(s)")


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
                             "close": row["close"], "atr": row["atr"]})
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

        # breadth = จำนวนสัญญาณวันนี้ — backtest ชี้ว่าวันฝูงใหญ่ (≥5-8) คือวันที่ fade ได้จริง
        breadth = len(hits)
        breadth_tag = " 🔥 วันฝูงใหญ่" if breadth >= 5 else ""
        lines = ["<b>🎯 Reversal watch — fade the top</b>",
                 f"model prob ≥ {tau} (เข้า short แท่งถัดไป, SL +{SL_ATR}×ATR / TP −{TP_ATR}×ATR)",
                 f"สัญญาณวันนี้: {breadth} ตัว{breadth_tag}", ""]
        for h in hits:
            lines.append(f"<code>{h['symbol']}</code>  prob {h['prob']:.0%} · RSI {h['rsi']:.0f}")
            price_part = f"ราคาล่าสุด {h['entry']:g}" if h["live"] else f"ราคาปิดแท่ง {h['entry']:g} (ดึงราคาสดไม่ได้)"
            lines.append(f"   {price_part} · SL {h['sl']:g} · TP {h['tp']:g}")
        lines.append("")
        lines.append("👇 กด ➕ เพื่อเพิ่มเข้า watchlist")
        send_telegram("\n".join(lines), reply_markup=_build_keyboard([h["symbol"] for h in hits]))
        state["alerted"].extend(h["symbol"] for h in hits)
        if not DRY_RUN:
            record_paper_trades(hits)

    if not DRY_RUN:
        STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    print("done")


if __name__ == "__main__":
    main()
