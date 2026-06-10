"""Out-of-sample backtest of the fade-short model (Phase D).

Re-runs the same walk-forward folds as train_model.py to get OOS probabilities,
then simulates real trades from OHLCV (entry next open, ATR brackets, 4h candles
resolve same-bar TP/SL ambiguity — identical mechanics to the label builder) and
sweeps tau x TP x SL. PnL is in R units (1R = SL distance), net of fees+slippage.

Usage:
    python3 backtest.py
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

from build_features import HORIZON, resolve_ambiguous_4h, wilder_atr
from train_model import (BREAKEVEN, EXCLUDE_SYMBOLS, FEATURES, N_TEST_WINDOWS, SL_ATR,
                         TP_ATR, TRAIN_FRACTION_MIN, fit_fold, tsa1_proba)

DATA_DIR = Path(__file__).parent / "data"
REPORT_FILE = DATA_DIR / "backtest_report.json"

FEE_PCT_ROUNDTRIP = 0.003   # taker 2 sides + slippage, fraction of notional
TAU_SWEEP = [0.30, 0.35, 0.40, 0.45, 0.50]
TP_SWEEP = [1.5, 2.0, 2.5, 3.0]
SL_SWEEP = [0.75, 1.0, 1.25]


def walk_forward_probs(df: pd.DataFrame) -> pd.DataFrame:
    """OOS ensemble probability for every event inside the test windows."""
    t0, t1 = df["open_time"].min(), df["open_time"].max()
    edges = np.linspace(t0 + (t1 - t0) * TRAIN_FRACTION_MIN, t1, N_TEST_WINDOWS + 1)
    parts = []
    for k in range(N_TEST_WINDOWS):
        ws, we = edges[k], edges[k + 1]
        train = df[df["open_time"] < ws - HORIZON * 86400]
        test = df[(df["open_time"] >= ws) & (df["open_time"] <= we)].copy()
        if len(train) < 500 or test.empty:
            continue
        learners, worst, _, _ = fit_fold(train)
        test["prob"] = tsa1_proba(learners, worst, test[FEATURES])
        parts.append(test)
        print(f"  fold {k + 1}: {len(test)} OOS events scored")
    return pd.concat(parts).reset_index(drop=True)


def load_ohlcv(symbols: set[str], events: pd.DataFrame) -> dict:
    """Per symbol: daily df with atr + open_time->row index, and 4h df."""
    ex_of = events.drop_duplicates("symbol").set_index("symbol")["exchange"]
    book = {}
    for sym in symbols:
        key = f"{sym}_{ex_of[sym]}"
        d = pd.read_parquet(DATA_DIR / "ohlcv" / f"{key}_1d.parquet")
        d["atr"] = wilder_atr(d)
        h4_path = DATA_DIR / "ohlcv" / f"{key}_4h.parquet"
        book[sym] = {
            "d": d,
            "idx": {int(t): i for i, t in enumerate(d["open_time"])},
            "h4": pd.read_parquet(h4_path) if h4_path.exists() else None,
        }
    return book


def simulate_trade(sym_data: dict, event_time: int, tp_atr: float, sl_atr: float) -> dict | None:
    """Short at next open with ATR brackets. Returns gross R and metadata, or None."""
    d, h4 = sym_data["d"], sym_data["h4"]
    i = sym_data["idx"].get(event_time)
    if i is None or i + 1 >= len(d):
        return None
    entry = d["open"].iloc[i + 1]
    atr = d["atr"].iloc[i]
    if not np.isfinite(atr) or atr <= 0:
        return None
    tp, sl = entry - tp_atr * atr, entry + sl_atr * atr
    last = min(i + HORIZON, len(d) - 1)
    risk = sl_atr * atr
    for j in range(i + 1, last + 1):
        hit_tp = d["low"].iloc[j] <= tp
        hit_sl = d["high"].iloc[j] >= sl
        if hit_tp and hit_sl:
            res = resolve_ambiguous_4h(h4, int(d["open_time"].iloc[j]), tp, sl) if h4 is not None else None
            if res is None:
                return None  # still ambiguous — skip, counted by caller
            hit_tp, hit_sl = res == 1, res == 0
        if hit_tp or hit_sl:
            exit_price = tp if hit_tp else sl
            return {"r": (entry - exit_price) / risk, "bars": j - i,
                    "exit_time": int(d["open_time"].iloc[j]), "risk_pct": risk / entry}
    if last < i + HORIZON:
        return None  # horizon beyond data end
    exit_price = d["close"].iloc[last]
    return {"r": (entry - exit_price) / risk, "bars": HORIZON,
            "exit_time": int(d["open_time"].iloc[last]), "risk_pct": risk / entry}


def run_config(events: pd.DataFrame, book: dict, tau: float, tp_atr: float, sl_atr: float) -> dict | None:
    picks = events[events["prob"] >= tau] if tau is not None else events
    trades = []
    for _, e in picks.iterrows():
        t = simulate_trade(book[e["symbol"]], int(e["open_time"]), tp_atr, sl_atr)
        if t is None:
            continue
        t["r_net"] = t["r"] - FEE_PCT_ROUNDTRIP / t["risk_pct"]
        trades.append(t)
    if len(trades) < 30:
        return None
    tr = pd.DataFrame(trades).sort_values("exit_time")
    r = tr["r_net"]
    equity = r.cumsum()
    max_dd = float((equity.cummax() - equity).max())
    starts = sorted(int(e) - b * 86400 for e, b in zip(tr["exit_time"], tr["bars"]))
    ends = sorted(int(e) for e in tr["exit_time"])
    concurrent, si, ei = 0, 0, 0
    while si < len(starts):
        if starts[si] < ends[ei]:
            si += 1
            concurrent = max(concurrent, si - ei)
        else:
            ei += 1
    return {
        "tau": tau, "tp_atr": tp_atr, "sl_atr": sl_atr,
        "trades": len(tr), "hit": float((r > 0).mean()), "sum_r": float(r.sum()),
        "avg_r": float(r.mean()), "max_dd_r": max_dd,
        "recovery": float(r.sum() / max_dd) if max_dd > 0 else float("nan"),
        "max_concurrent": concurrent, "avg_bars": float(tr["bars"].mean()),
    }


def fmt(c: dict) -> str:
    return (f"tau={c['tau']}, TP={c['tp_atr']}xATR SL={c['sl_atr']}xATR: {c['trades']} trades, "
            f"hit {c['hit']:.1%}, avg {c['avg_r']:+.3f}R, total {c['sum_r']:+.1f}R, "
            f"maxDD {c['max_dd_r']:.1f}R, recovery {c['recovery']:.2f}, "
            f"max concurrent {c['max_concurrent']}")


def main() -> None:
    df = pd.read_parquet(DATA_DIR / "features.parquet")
    df = df[~df["symbol"].isin(EXCLUDE_SYMBOLS)].sort_values("open_time").reset_index(drop=True)
    print(f"events: {len(df)} — scoring OOS probabilities (walk-forward, same folds as training)")
    events = walk_forward_probs(df)
    print(f"OOS events: {len(events)} ({pd.Timestamp(events['open_time'].min(), unit='s', tz='UTC'):%Y-%m} -> "
          f"{pd.Timestamp(events['open_time'].max(), unit='s', tz='UTC'):%Y-%m})\n")
    book = load_ohlcv(set(events["symbol"]), events)

    baseline = run_config(events, book, None, TP_ATR, SL_ATR)
    print(f"baseline (every event):  {fmt(baseline)}")
    default = run_config(events, book, 0.35, TP_ATR, SL_ATR)
    print(f"model default:           {fmt(default)}\n")

    print("sweeping tau x TP x SL ...")
    results = []
    for tau in TAU_SWEEP:
        for tp in TP_SWEEP:
            for sl in SL_SWEEP:
                c = run_config(events, book, tau, tp, sl)
                if c:
                    results.append(c)
    results = [c for c in results if c["trades"] >= 100]
    results.sort(key=lambda c: c["recovery"], reverse=True)
    print("\ntop 5 by recovery ratio (total R / maxDD, min 100 trades):")
    for c in results[:5]:
        print(f"  {fmt(c)}")

    REPORT_FILE.write_text(json.dumps({
        "oos_range": [int(events["open_time"].min()), int(events["open_time"].max())],
        "fee_pct_roundtrip": FEE_PCT_ROUNDTRIP, "breakeven_note": f"R=2 breakeven {BREAKEVEN:.3f}",
        "baseline": baseline, "model_default": default, "sweep_top20": results[:20],
    }, indent=2) + "\n")
    print(f"\nsaved -> {REPORT_FILE}")


if __name__ == "__main__":
    main()
