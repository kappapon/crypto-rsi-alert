"""Build event dataset for the ML pipeline (Phase B): features + triple-barrier labels.

Event = daily bar where RSI(14) >= RSI_ENTRY (or within EXIT_WINDOW bars after dropping back).
Label = fade-short entered at next bar open: 1 if TP (TP_ATR x ATR below entry) is hit
before SL (SL_ATR x ATR above entry) within HORIZON daily bars, else 0.
Same-bar TP/SL ambiguity is resolved with 4h candles; still-ambiguous rows are dropped.

Usage:
    python3 build_features.py            # all symbols in data/ohlcv/
    python3 build_features.py BTCUSDT    # one symbol (debug)
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).parent / "data" / "ohlcv"
OUT_FILE = Path(__file__).parent / "data" / "features.parquet"

DIRECTION = "short"   # fade the top (confirmed 2026-06-10); "long" mirrors the barriers
RSI_ENTRY = 70
EXIT_WINDOW = 5       # keep sampling N bars after RSI drops back below RSI_ENTRY
TP_ATR = 2.0
SL_ATR = 1.0
HORIZON = 10          # daily bars; unresolved -> label 0 (timeout)
WARMUP = 60           # bars required before first event (EMA50 + ATR stability)

FEATURES = [
    "rsi", "rsi_slope_3", "bars_above_70", "rsi_4h",
    "dist_ema20", "dist_ema50", "dist_ath",
    "atr_pct", "rvol_5", "rvol_20", "vol_z",
    "ret_1", "ret_3", "ret_7", "btc_ret_7", "corr_btc_20",
]


def wilder_rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def wilder_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    prev_close = df["close"].shift()
    tr = pd.concat([
        df["high"] - df["low"],
        (df["high"] - prev_close).abs(),
        (df["low"] - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def daily_rsi_4h(df_4h: pd.DataFrame) -> pd.Series:
    """Last closed 4h RSI of each UTC day, indexed by day open_time (epoch sec)."""
    rsi = wilder_rsi(df_4h["close"])
    day = (df_4h["open_time"] // 86400) * 86400
    return rsi.groupby(day).last()


def build_symbol_features(df: pd.DataFrame, df_4h: pd.DataFrame | None, btc: pd.DataFrame | None) -> pd.DataFrame:
    out = df.copy()
    out["rsi"] = wilder_rsi(out["close"])
    out["rsi_slope_3"] = out["rsi"] - out["rsi"].shift(3)
    below = (out["rsi"] < RSI_ENTRY).cumsum()
    out["bars_above_70"] = out.groupby(below).cumcount()
    out["dist_ema20"] = out["close"] / out["close"].ewm(span=20, adjust=False).mean() - 1
    out["dist_ema50"] = out["close"] / out["close"].ewm(span=50, adjust=False).mean() - 1
    out["dist_ath"] = out["close"] / out["high"].cummax() - 1
    out["atr"] = wilder_atr(out)
    out["atr_pct"] = out["atr"] / out["close"]
    ret = out["close"].pct_change()
    out["rvol_5"] = ret.rolling(5).std()
    out["rvol_20"] = ret.rolling(20).std()
    out["vol_z"] = (out["volume"] - out["volume"].rolling(20).mean()) / out["volume"].rolling(20).std()
    out["ret_1"] = ret
    out["ret_3"] = out["close"].pct_change(3)
    out["ret_7"] = out["close"].pct_change(7)

    if df_4h is not None and not df_4h.empty:
        out["rsi_4h"] = out["open_time"].map(daily_rsi_4h(df_4h))
    else:
        out["rsi_4h"] = np.nan

    if btc is not None:
        b = btc.set_index("open_time")["close"]
        out["btc_ret_7"] = out["open_time"].map(b.pct_change(7))
        b_ret_aligned = pd.Series(out["open_time"].map(b.pct_change()).values, index=out.index)
        out["corr_btc_20"] = ret.rolling(20).corr(b_ret_aligned)
    else:
        out["btc_ret_7"] = np.nan
        out["corr_btc_20"] = np.nan
    return out


def resolve_ambiguous_4h(df_4h: pd.DataFrame, day_open: int, tp: float, sl: float) -> int | None:
    """Walk 4h bars of one day; return 1 (tp first), 0 (sl first), None (still ambiguous)."""
    bars = df_4h[(df_4h["open_time"] >= day_open) & (df_4h["open_time"] < day_open + 86400)]
    for _, b in bars.iterrows():
        hit_tp, hit_sl = b["low"] <= tp, b["high"] >= sl
        if hit_tp and hit_sl:
            return None
        if hit_tp:
            return 1
        if hit_sl:
            return 0
    return None


def label_event(df: pd.DataFrame, i: int, df_4h: pd.DataFrame | None) -> tuple[int, str, int] | None:
    """Triple-barrier label for fade-short decided at bar i, entered at bar i+1 open.

    Returns (label, outcome, bars_held) or None if dropped (ambiguous) / no next bar.
    """
    if i + 1 >= len(df):
        return None
    entry = df["open"].iloc[i + 1]
    atr = df["atr"].iloc[i]
    if DIRECTION == "short":
        tp, sl = entry - TP_ATR * atr, entry + SL_ATR * atr
    else:
        tp, sl = entry + TP_ATR * atr, entry - SL_ATR * atr
    last = min(i + HORIZON, len(df) - 1)
    for j in range(i + 1, last + 1):
        if DIRECTION == "short":
            hit_tp = df["low"].iloc[j] <= tp
            hit_sl = df["high"].iloc[j] >= sl
        else:
            hit_tp = df["high"].iloc[j] >= tp
            hit_sl = df["low"].iloc[j] <= sl
        if hit_tp and hit_sl:
            if df_4h is not None:
                res = resolve_ambiguous_4h(df_4h, int(df["open_time"].iloc[j]), tp, sl)
                if res is not None:
                    return res, "tp" if res else "sl", j - i
            return None
        if hit_tp:
            return 1, "tp", j - i
        if hit_sl:
            return 0, "sl", j - i
    if last < i + HORIZON:
        return None  # horizon extends past data end — label not final yet
    return 0, "timeout", HORIZON


def load(symbol_exchange_tf: str) -> pd.DataFrame | None:
    p = DATA_DIR / f"{symbol_exchange_tf}.parquet"
    return pd.read_parquet(p) if p.exists() else None


def main() -> None:
    only = sys.argv[1] if len(sys.argv) > 1 else None
    daily_files = sorted(DATA_DIR.glob("*_1d.parquet"))
    if only:
        daily_files = [f for f in daily_files if f.name.startswith(only + "_")]
    if not daily_files:
        sys.exit("no daily parquet files found — run fetch_data.py first")

    btc = load("BTCUSDT_binance_spot_1d")
    rows = []
    dropped = 0
    for f in daily_files:
        key = f.stem.removesuffix("_1d")  # SYMBOL_exchange
        symbol, exchange = key.rsplit("_", 2)[0], "_".join(key.rsplit("_", 2)[1:])
        df = pd.read_parquet(f)
        if len(df) < WARMUP + HORIZON:
            continue
        df_4h = load(f"{key}_4h")
        feat = build_symbol_features(df, df_4h, btc)

        recently_ob = (feat["rsi"] >= RSI_ENTRY).rolling(EXIT_WINDOW + 1, min_periods=1).max() == 1
        event_idx = feat.index[(recently_ob) & (feat.index >= WARMUP) & feat["atr"].notna()]
        for i in event_idx:
            lab = label_event(feat, int(i), df_4h)
            if lab is None:
                dropped += 1
                continue
            label, outcome, bars_held = lab
            row = {"symbol": symbol, "exchange": exchange, "open_time": int(feat["open_time"].iloc[i]),
                   "label": label, "outcome": outcome, "bars_held": bars_held}
            row.update({c: feat[c].iloc[i] for c in FEATURES})
            rows.append(row)

    if not rows:
        sys.exit("no events found")
    out = pd.DataFrame(rows).sort_values(["open_time", "symbol"]).reset_index(drop=True)
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    out.to_parquet(OUT_FILE, index=False)

    total = len(out) + dropped
    print(f"events: {len(out)} kept, {dropped} dropped ambiguous ({dropped / total:.1%} — Inglese threshold <5%)")
    print(f"symbols with events: {out['symbol'].nunique()}")
    print(f"date range: {pd.Timestamp(out['open_time'].min(), unit='s', tz='UTC'):%Y-%m-%d} -> "
          f"{pd.Timestamp(out['open_time'].max(), unit='s', tz='UTC'):%Y-%m-%d}")
    print(f"label balance (1 = fade wins): {out['label'].mean():.1%}")
    print("outcomes:", out["outcome"].value_counts().to_dict())
    print("top symbols:", out["symbol"].value_counts().head(10).to_dict())
    nan_pct = out[FEATURES].isna().mean()
    bad = nan_pct[nan_pct > 0.05]
    if not bad.empty:
        print("features with >5% NaN:", bad.round(3).to_dict())
    print(f"saved -> {OUT_FILE}")


if __name__ == "__main__":
    main()
