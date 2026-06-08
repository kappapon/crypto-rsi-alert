"""Scan Binance USDT spot pairs for daily RSI > 70 / > 80 (live candle) and alert via Telegram."""
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

import pandas as pd
import requests

BINANCE_BASE = "https://data-api.binance.vision"
STATE_FILE = Path(__file__).parent / "state.json"
RSI_PERIOD = 14
KLINE_LIMIT = 100
LEVEL_OVERBOUGHT = 70
LEVEL_EXTREME = 80

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
CHAT_ID = os.environ.get("CHAT_ID", "")
DRY_RUN = os.environ.get("DRY_RUN") == "1"


def fetch_usdt_symbols() -> list[str]:
    r = requests.get(f"{BINANCE_BASE}/api/v3/exchangeInfo", timeout=30)
    r.raise_for_status()
    data = r.json()
    return sorted(
        s["symbol"]
        for s in data["symbols"]
        if s["quoteAsset"] == "USDT"
        and s["status"] == "TRADING"
        and s["isSpotTradingAllowed"]
    )


def fetch_daily_closes(symbol: str) -> list[float] | None:
    """Return daily closes including the in-progress (live) candle's current close."""
    r = requests.get(
        f"{BINANCE_BASE}/api/v3/klines",
        params={"symbol": symbol, "interval": "1d", "limit": KLINE_LIMIT},
        timeout=30,
    )
    r.raise_for_status()
    klines = r.json()
    closes = [float(k[4]) for k in klines]
    if len(closes) < RSI_PERIOD + 1:
        return None
    return closes


def calc_rsi(closes: list[float], period: int = RSI_PERIOD) -> float:
    """Wilder's RSI — matches TradingView."""
    s = pd.Series(closes)
    delta = s.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    return float(rsi.iloc[-1])


def load_state(today_utc: str) -> dict:
    """Load state, resetting levels when the UTC date rolls over."""
    fresh = {"date": today_utc, "levels": {}}
    if not STATE_FILE.exists():
        return fresh
    try:
        data = json.loads(STATE_FILE.read_text())
    except json.JSONDecodeError:
        return fresh
    if not isinstance(data, dict) or "levels" not in data or data.get("date") != today_utc:
        return fresh
    return data


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")


def send_telegram(text: str, reply_markup: dict | None = None) -> None:
    payload: dict = {"chat_id": CHAT_ID, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    if DRY_RUN:
        print("--- DRY RUN — would send: ---")
        print(text)
        if reply_markup:
            print("--- reply_markup: ---")
            print(json.dumps(reply_markup, indent=2, ensure_ascii=False))
        return
    if not BOT_TOKEN or not CHAT_ID:
        print("ERROR: BOT_TOKEN / CHAT_ID not set", file=sys.stderr)
        sys.exit(1)
    r = requests.post(
        f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
        json=payload,
        timeout=30,
    )
    r.raise_for_status()


def determine_level(rsi: float) -> int:
    if rsi >= LEVEL_EXTREME:
        return LEVEL_EXTREME
    if rsi >= LEVEL_OVERBOUGHT:
        return LEVEL_OVERBOUGHT
    return 0


def main() -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}] scan start")
    today_utc = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    symbols = fetch_usdt_symbols()
    print(f"Fetched {len(symbols)} USDT spot symbols")

    state = load_state(today_utc)
    levels: dict[str, int] = state["levels"]
    new_alerts: list[tuple[str, float, int]] = []
    errors = 0

    for i, sym in enumerate(symbols, 1):
        try:
            closes = fetch_daily_closes(sym)
            if not closes:
                continue
            rsi = calc_rsi(closes)
            if pd.isna(rsi):
                continue

            prev_level = levels.get(sym, 0)
            curr_level = determine_level(rsi)

            if curr_level > prev_level:
                new_alerts.append((sym, rsi, curr_level))
                levels[sym] = curr_level
        except Exception as e:
            errors += 1
            print(f"  {sym}: error {e}", file=sys.stderr)

        if i % 50 == 0:
            print(f"  scanned {i}/{len(symbols)}")

    print(f"Done. Alerts: {len(new_alerts)}, errors: {errors}")

    if new_alerts:
        new_alerts.sort(key=lambda x: (-x[2], -x[1]))
        lines = ["<b>Daily RSI Alert</b>", ""]
        extreme = [a for a in new_alerts if a[2] == LEVEL_EXTREME]
        over = [a for a in new_alerts if a[2] == LEVEL_OVERBOUGHT]
        if extreme:
            lines.append("🚨 <b>Extreme (RSI &gt; 80)</b>")
            for sym, rsi, _ in extreme:
                lines.append(f"  <code>{sym}</code>  {rsi:.1f}")
            lines.append("")
        if over:
            lines.append("⚠️ <b>Overbought (RSI &gt; 70)</b>")
            for sym, rsi, _ in over:
                lines.append(f"  <code>{sym}</code>  {rsi:.1f}")
        lines.append("")
        lines.append("👇 กด ➕ เพื่อเพิ่มเข้า watchlist (5-15 นาที workflow ถัดไปจะ commit)")
        reply_markup = _build_keyboard([sym for sym, _, _ in new_alerts])
        send_telegram("\n".join(lines), reply_markup=reply_markup)

    save_state(state)


def _build_keyboard(symbols: list[str], per_row: int = 2, max_buttons: int = 40) -> dict:
    """Build Telegram inline_keyboard ➕ SYMBOL buttons. Limit to max_buttons (Telegram caps ~100)."""
    syms = symbols[:max_buttons]
    rows = []
    for i in range(0, len(syms), per_row):
        rows.append([
            {"text": f"➕ {s}", "callback_data": f"add:{s}"} for s in syms[i:i + per_row]
        ])
    return {"inline_keyboard": rows}


if __name__ == "__main__":
    main()
