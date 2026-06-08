"""Watchlist scanner — alert on price/funding triggers for selected tickers across exchanges."""
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

import requests

BINANCE_FUTURES_BASE = "https://fapi.binance.com"
BINANCE_SPOT_BASE = "https://data-api.binance.vision"
GATEIO_BASE = "https://api.gateio.ws/api/v4"

CONFIG_FILE = Path(__file__).parent / "watchlist.json"
STATE_FILE = Path(__file__).parent / "watchlist_state.json"

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
CHAT_ID = os.environ.get("CHAT_ID", "")
DRY_RUN = os.environ.get("DRY_RUN") == "1"


def fetch_ticker(symbol: str, exchange: str) -> dict | None:
    """Return {price, funding_rate, change_24h, volume_24h} or None on error."""
    try:
        if exchange == "binance_futures":
            r = requests.get(
                f"{BINANCE_FUTURES_BASE}/fapi/v1/premiumIndex",
                params={"symbol": symbol},
                timeout=15,
            )
            r.raise_for_status()
            d = r.json()
            r2 = requests.get(
                f"{BINANCE_FUTURES_BASE}/fapi/v1/ticker/24hr",
                params={"symbol": symbol},
                timeout=15,
            )
            r2.raise_for_status()
            d2 = r2.json()
            return {
                "price": float(d["markPrice"]),
                "funding_rate": float(d["lastFundingRate"]) * 100,
                "change_24h": float(d2["priceChangePercent"]),
                "volume_24h": float(d2["quoteVolume"]),
            }
        if exchange == "binance_spot":
            r = requests.get(
                f"{BINANCE_SPOT_BASE}/api/v3/ticker/24hr",
                params={"symbol": symbol},
                timeout=15,
            )
            r.raise_for_status()
            d = r.json()
            return {
                "price": float(d["lastPrice"]),
                "funding_rate": 0.0,
                "change_24h": float(d["priceChangePercent"]),
                "volume_24h": float(d["quoteVolume"]),
            }
        if exchange == "gateio_futures":
            r = requests.get(
                f"{GATEIO_BASE}/futures/usdt/tickers",
                params={"contract": symbol},
                timeout=15,
            )
            r.raise_for_status()
            arr = r.json()
            if not arr:
                return None
            d = arr[0]
            return {
                "price": float(d["last"]),
                "funding_rate": float(d["funding_rate"]) * 100,
                "change_24h": float(d["change_percentage"]),
                "volume_24h": float(d["volume_24h_quote"]),
            }
    except Exception as e:
        print(f"  fetch error {symbol}@{exchange}: {e}", file=sys.stderr)
        return None
    return None


def load_json(path: Path, default: dict) -> dict:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return default


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")


def send_telegram(text: str) -> None:
    if DRY_RUN:
        print("--- DRY RUN — would send: ---")
        print(text)
        return
    if not BOT_TOKEN or not CHAT_ID:
        print("ERROR: BOT_TOKEN / CHAT_ID not set", file=sys.stderr)
        sys.exit(1)
    r = requests.post(
        f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
        json={"chat_id": CHAT_ID, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True},
        timeout=30,
    )
    r.raise_for_status()


def in_cooldown(state_entry: dict, key: str, cooldown_minutes: int) -> bool:
    last = state_entry.get("triggers", {}).get(key)
    if not last:
        return False
    last_dt = dt.datetime.fromisoformat(last)
    delta = dt.datetime.now(dt.timezone.utc) - last_dt
    return delta.total_seconds() < cooldown_minutes * 60


def mark_triggered(state_entry: dict, key: str) -> None:
    state_entry.setdefault("triggers", {})[key] = dt.datetime.now(dt.timezone.utc).isoformat()


def check_triggers(symbol: str, cfg: dict, ticker_data: dict, prev_price: float | None,
                   state_entry: dict, cooldown_minutes: int) -> list[str]:
    """Return list of alert message lines triggered for this ticker."""
    alerts = []
    price = ticker_data["price"]
    levels = cfg["levels"]
    alert_cfg = cfg.get("alerts", {})

    def crossed_up(level: float) -> bool:
        return prev_price is not None and prev_price < level <= price

    def crossed_down(level: float) -> bool:
        return prev_price is not None and prev_price > level >= price

    if alert_cfg.get("price_breakout") and "breakout_above" in levels:
        level = levels["breakout_above"]
        if crossed_up(level) and not in_cooldown(state_entry, "breakout", cooldown_minutes):
            alerts.append(f"⚡ <b>BREAKOUT</b> — ทะลุ {level} (LONG signal)")
            mark_triggered(state_entry, "breakout")

    if alert_cfg.get("price_rejection") and "rejection_below" in levels:
        level = levels["rejection_below"]
        if crossed_down(level) and not in_cooldown(state_entry, "rejection", cooldown_minutes):
            alerts.append(f"🔻 <b>REJECTION</b> — หลุด {level} (SHORT signal)")
            mark_triggered(state_entry, "rejection")

    if alert_cfg.get("support_break") and "support_strong" in levels:
        level = levels["support_strong"]
        if crossed_down(level) and not in_cooldown(state_entry, "support_break", cooldown_minutes):
            alerts.append(f"💥 <b>SUPPORT BREAK</b> — หลุด {level} (deeper correction)")
            mark_triggered(state_entry, "support_break")

    if "resistance" in levels:
        level = levels["resistance"]
        if crossed_up(level) and not in_cooldown(state_entry, "resistance_test", cooldown_minutes):
            alerts.append(f"⚠️ <b>ATH TEST</b> — แตะ resistance {level}")
            mark_triggered(state_entry, "resistance_test")

    funding_threshold = alert_cfg.get("funding_high")
    if funding_threshold:
        funding = ticker_data["funding_rate"]
        if abs(funding) >= funding_threshold and not in_cooldown(state_entry, "funding", cooldown_minutes):
            direction = "longs paying" if funding > 0 else "shorts paying"
            alerts.append(f"🔥 <b>FUNDING HIGH</b> — {funding:+.3f}% ({direction})")
            mark_triggered(state_entry, "funding")

    return alerts


def format_alert(symbol: str, ticker_data: dict, alerts: list[str]) -> str:
    price = ticker_data["price"]
    change = ticker_data["change_24h"]
    funding = ticker_data["funding_rate"]
    volume_m = ticker_data["volume_24h"] / 1_000_000
    lines = [
        f"🚨 <b>{symbol}</b>",
        f"💵 {price:.6g} ({change:+.2f}% 24h)",
        f"💰 Funding: {funding:+.3f}% | Vol: ${volume_m:.1f}M",
        "",
        *alerts,
    ]
    return "\n".join(lines)


def main() -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}] watchlist scan start")
    config = load_json(CONFIG_FILE, {"tickers": {}, "settings": {}})
    if not config.get("settings", {}).get("enabled", True):
        print("Watchlist globally disabled — exiting.")
        return

    cooldown = config.get("settings", {}).get("cooldown_minutes", 30)
    state = load_json(STATE_FILE, {"tickers": {}})
    state.setdefault("tickers", {})

    total_alerts = []
    for symbol, cfg in config["tickers"].items():
        if not cfg.get("enabled", True):
            continue
        exchange = cfg["exchange"]
        ticker_data = fetch_ticker(symbol, exchange)
        if not ticker_data:
            print(f"  {symbol}: no data")
            continue

        entry = state["tickers"].setdefault(symbol, {})
        prev_price = entry.get("last_price")

        alerts = check_triggers(symbol, cfg, ticker_data, prev_price, entry, cooldown)

        entry["last_price"] = ticker_data["price"]
        entry["last_funding"] = ticker_data["funding_rate"]
        entry["last_updated"] = dt.datetime.now(dt.timezone.utc).isoformat()

        if alerts:
            msg = format_alert(symbol, ticker_data, alerts)
            total_alerts.append(msg)
            print(f"  {symbol}: {len(alerts)} alert(s)")
        else:
            print(f"  {symbol}: price={ticker_data['price']:.6g} (no triggers)")

    if total_alerts:
        send_telegram("\n\n".join(total_alerts))

    save_state(state)
    print(f"Done. Tickers: {len(config['tickers'])}, alerts sent: {len(total_alerts)}")


if __name__ == "__main__":
    main()
