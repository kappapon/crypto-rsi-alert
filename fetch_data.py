"""Fetch historical OHLCV into data/ohlcv/*.parquet for the ML pipeline (Phase A).

Usage:
    python3 fetch_data.py BTCUSDT                          # binance_spot, 1d+4h, 3y
    python3 fetch_data.py BEAT_USDT                        # exchange auto from watchlist.json
    python3 fetch_data.py BTCUSDT --tf 1h --years 1        # backtest resolution
    python3 fetch_data.py --universe 150                   # top-N spot by volume (training set)
"""
import argparse
import json
import sys
import time
from pathlib import Path

import pandas as pd
import requests

BINANCE_BASE = "https://data-api.binance.vision"
GATE_BASE = "https://api.gateio.ws/api/v4"
DATA_DIR = Path(__file__).parent / "data" / "ohlcv"
WATCHLIST_FILE = Path(__file__).parent / "watchlist.json"

INTERVAL_SEC = {"1d": 86400, "4h": 14400, "1h": 3600, "15m": 900}
GATE_MAX_POINTS = 9900  # API rejects >10000 candles back ("too long ago")
GATE_PAGE = 1900  # max ~2000 points per from/to query
STABLE_BASES = {"USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "EUR", "AEUR", "USDE", "USD1"}


def now_sec() -> int:
    return int(time.time())


def fetch_binance_klines(symbol: str, tf: str, start_sec: int) -> pd.DataFrame:
    """Paginate /api/v3/klines from start_sec to now. Closed candles only."""
    rows = []
    start_ms = start_sec * 1000
    while True:
        r = requests.get(
            f"{BINANCE_BASE}/api/v3/klines",
            params={"symbol": symbol, "interval": tf, "startTime": start_ms, "limit": 1000},
            timeout=30,
        )
        r.raise_for_status()
        klines = r.json()
        if not klines:
            break
        now_ms = now_sec() * 1000
        rows.extend(k for k in klines if k[6] < now_ms)  # k[6] = closeTime
        if len(klines) < 1000:
            break
        start_ms = klines[-1][0] + 1
        time.sleep(0.15)
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(
        [[k[0] // 1000, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])] for k in rows],
        columns=["open_time", "open", "high", "low", "close", "volume"],
    )
    return df


def fetch_gate_futures_candles(contract: str, tf: str, start_sec: int) -> pd.DataFrame:
    """Paginate /futures/usdt/candlesticks with from/to. Closed candles only."""
    step = INTERVAL_SEC[tf]
    earliest = now_sec() - GATE_MAX_POINTS * step
    if start_sec < earliest:
        print(f"  note: Gate caps history at {GATE_MAX_POINTS} candles — start clamped to {pd.Timestamp(earliest, unit='s', tz='UTC'):%Y-%m-%d}")
        start_sec = earliest
    rows = []
    frm = start_sec
    while frm < now_sec():
        to = min(frm + GATE_PAGE * step, now_sec())
        r = requests.get(
            f"{GATE_BASE}/futures/usdt/candlesticks",
            params={"contract": contract, "interval": tf, "from": frm, "to": to},
            timeout=30,
        )
        r.raise_for_status()
        candles = r.json()
        cutoff = now_sec() - step  # open_time of a closed candle
        rows.extend(c for c in candles if int(c["t"]) <= cutoff)
        frm = to + step
        time.sleep(0.2)
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(
        [[int(c["t"]), float(c["o"]), float(c["h"]), float(c["l"]), float(c["c"]), float(c["v"])] for c in rows],
        columns=["open_time", "open", "high", "low", "close", "volume"],
    )
    return df


def parquet_path(symbol: str, exchange: str, tf: str) -> Path:
    return DATA_DIR / f"{symbol}_{exchange}_{tf}.parquet"


def fetch_symbol(symbol: str, exchange: str, tf: str, years: float) -> int:
    """Fetch one symbol/timeframe incrementally. Returns rows added."""
    path = parquet_path(symbol, exchange, tf)
    existing = pd.read_parquet(path) if path.exists() else pd.DataFrame()
    if not existing.empty:
        start_sec = int(existing["open_time"].max()) + INTERVAL_SEC[tf]
    else:
        start_sec = now_sec() - int(years * 365 * 86400)

    if exchange == "binance_spot":
        new = fetch_binance_klines(symbol, tf, start_sec)
    elif exchange == "gateio_futures":
        new = fetch_gate_futures_candles(symbol, tf, start_sec)
    else:
        raise ValueError(f"unknown exchange: {exchange}")

    if new.empty and existing.empty:
        print(f"  {symbol} {tf}: no data")
        return 0
    df = pd.concat([existing, new]).drop_duplicates("open_time").sort_values("open_time").reset_index(drop=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False)
    print(f"  {symbol} {tf}: +{len(new)} rows (total {len(df)}, "
          f"{pd.Timestamp(df['open_time'].iloc[0], unit='s', tz='UTC'):%Y-%m-%d} → "
          f"{pd.Timestamp(df['open_time'].iloc[-1], unit='s', tz='UTC'):%Y-%m-%d})")
    return len(new)


def exchange_from_watchlist(symbol: str) -> str | None:
    if not WATCHLIST_FILE.exists():
        return None
    tickers = json.loads(WATCHLIST_FILE.read_text()).get("tickers", {})
    entry = tickers.get(symbol)
    return entry.get("exchange") if entry else None


def top_universe(n: int) -> list[str]:
    """Top-n Binance USDT spot symbols by 24h quote volume, stable-base pairs excluded."""
    r = requests.get(f"{BINANCE_BASE}/api/v3/exchangeInfo", timeout=30)
    r.raise_for_status()
    base_of = {
        s["symbol"]: s["baseAsset"]
        for s in r.json()["symbols"]
        if s["quoteAsset"] == "USDT" and s["status"] == "TRADING" and s["isSpotTradingAllowed"]
    }
    r = requests.get(f"{BINANCE_BASE}/api/v3/ticker/24hr", timeout=30)
    r.raise_for_status()
    ranked = sorted(
        (t for t in r.json() if t["symbol"] in base_of and base_of[t["symbol"]] not in STABLE_BASES),
        key=lambda t: float(t["quoteVolume"]),
        reverse=True,
    )
    return [t["symbol"] for t in ranked[:n]]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("symbol", nargs="?", help="e.g. BTCUSDT or BEAT_USDT")
    ap.add_argument("--exchange", choices=["binance_spot", "gateio_futures"], default=None)
    ap.add_argument("--tf", default="1d,4h", help="comma list: 1d,4h,1h,15m")
    ap.add_argument("--years", type=float, default=3.0)
    ap.add_argument("--universe", type=int, default=0, help="fetch top-N binance spot by volume instead of one symbol")
    args = ap.parse_args()

    tfs = [t.strip() for t in args.tf.split(",")]
    for tf in tfs:
        if tf not in INTERVAL_SEC:
            sys.exit(f"unsupported timeframe: {tf}")

    if args.universe:
        symbols = top_universe(args.universe)
        print(f"Universe: top {len(symbols)} by 24h quote volume")
        for i, sym in enumerate(symbols, 1):
            print(f"[{i}/{len(symbols)}] {sym}")
            for tf in tfs:
                try:
                    fetch_symbol(sym, "binance_spot", tf, args.years)
                except Exception as e:
                    print(f"  {sym} {tf}: error {e}", file=sys.stderr)
        return

    if not args.symbol:
        sys.exit("need a symbol or --universe N")
    exchange = args.exchange or exchange_from_watchlist(args.symbol) or "binance_spot"
    print(f"{args.symbol} ({exchange}) tf={','.join(tfs)} years={args.years}")
    for tf in tfs:
        fetch_symbol(args.symbol, exchange, tf, args.years)


if __name__ == "__main__":
    main()
