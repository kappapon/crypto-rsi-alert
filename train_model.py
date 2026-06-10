"""Train the fade-short reversal model (Phase C): 5-learner ensemble + T-SA-1 + OPTPREC.

Recipe from CFA Paper 1 (Anciaux) via HopbitVault:
- 5 base learners -> T-SA-1: drop the worst by validation average precision, average the rest
- OPTPREC: threshold tau picked on a chronological validation tail to maximize precision,
  subject to a recall floor (avoids a tau that never trades)
- Walk-forward evaluation: expanding train window, sequential test windows, with an
  embargo of HORIZON days so barrier outcomes never straddle the train/test boundary

Usage:
    python3 train_model.py            # walk-forward report + save final model
"""
import json
import pickle
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier, HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score
from sklearn.neighbors import KNeighborsClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from build_features import FEATURES, HORIZON, SL_ATR, TF, TF_SUFFIX, TP_ATR

FEATURES_FILE = Path(__file__).parent / "data" / f"features{TF_SUFFIX}.parquet"
MODEL_DIR = Path(__file__).parent / "models"

EXCLUDE_SYMBOLS = {"PAXGUSDT", "WBTCUSDT"}  # tokenized gold / BTC duplicate
BAR_SEC = 86400 if TF == "1d" else 14400
N_TEST_WINDOWS = 5
TRAIN_FRACTION_MIN = 3 / 8       # first chunks reserved as initial train window
VAL_FRACTION = 0.15              # chronological tail of train used for tau + trimming
RECALL_FLOOR = 0.10
MIN_VAL_TRADES = 20
TAU_GRID = np.round(np.arange(0.20, 0.66, 0.025), 3)
BREAKEVEN = SL_ATR / (TP_ATR + SL_ATR)  # win rate needed at this R


def build_learners() -> dict:
    return {
        "lr": make_pipeline(SimpleImputer(strategy="median"), StandardScaler(),
                            LogisticRegression(max_iter=2000)),
        "rf": make_pipeline(SimpleImputer(strategy="median"),
                            RandomForestClassifier(n_estimators=300, max_depth=6, min_samples_leaf=20,
                                                   n_jobs=-1, random_state=42)),
        "gb": make_pipeline(SimpleImputer(strategy="median"),
                            GradientBoostingClassifier(n_estimators=200, max_depth=3, random_state=42)),
        "hgb": HistGradientBoostingClassifier(max_depth=4, max_iter=300, random_state=42),
        "knn": make_pipeline(SimpleImputer(strategy="median"), StandardScaler(),
                             KNeighborsClassifier(n_neighbors=50)),
    }


def tsa1_fit(X_tr, y_tr, X_val, y_val) -> tuple[dict, str, dict]:
    """Fit all learners, rank on validation AP, mark the worst for dropping."""
    learners = build_learners()
    val_ap = {}
    for name, model in learners.items():
        model.fit(X_tr, y_tr)
        val_ap[name] = average_precision_score(y_val, model.predict_proba(X_val)[:, 1])
    worst = min(val_ap, key=val_ap.get)
    return learners, worst, val_ap


def tsa1_proba(learners: dict, worst: str, X) -> np.ndarray:
    probs = [m.predict_proba(X)[:, 1] for name, m in learners.items() if name != worst]
    return np.mean(probs, axis=0)


def optprec_tau(probs_val: np.ndarray, y_val: np.ndarray) -> float:
    """Paper 1 OPTPREC: argmax precision s.t. recall floor + minimum trade count."""
    best_tau, best_prec = float(TAU_GRID[0]), -1.0
    positives = max(int(y_val.sum()), 1)
    for tau in TAU_GRID:
        pick = probs_val >= tau
        if pick.sum() < MIN_VAL_TRADES:
            continue
        hits = int(y_val[pick].sum())
        recall = hits / positives
        precision = hits / int(pick.sum())
        if recall >= RECALL_FLOOR and precision > best_prec:
            best_tau, best_prec = float(tau), precision
    return best_tau


def split_train_val(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    cut = df["open_time"].quantile(1 - VAL_FRACTION)
    return df[df["open_time"] < cut], df[df["open_time"] >= cut]


def fit_fold(train: pd.DataFrame) -> tuple[dict, str, float, dict]:
    tr, val = split_train_val(train)
    learners, worst, val_ap = tsa1_fit(tr[FEATURES], tr["label"], val[FEATURES], val["label"])
    tau = optprec_tau(tsa1_proba(learners, worst, val[FEATURES]), val["label"].to_numpy())
    return learners, worst, tau, val_ap


def main() -> None:
    df = pd.read_parquet(FEATURES_FILE)
    df = df[~df["symbol"].isin(EXCLUDE_SYMBOLS)].sort_values("open_time").reset_index(drop=True)
    print(f"events: {len(df)} ({df['symbol'].nunique()} symbols, excluded {sorted(EXCLUDE_SYMBOLS)})")
    print(f"base win rate: {df['label'].mean():.1%}   breakeven at R={TP_ATR / SL_ATR:.0f}: {BREAKEVEN:.1%}\n")

    t0, t1 = df["open_time"].min(), df["open_time"].max()
    first_test_start = t0 + (t1 - t0) * TRAIN_FRACTION_MIN
    test_edges = np.linspace(first_test_start, t1, N_TEST_WINDOWS + 1)

    print(f"walk-forward: {N_TEST_WINDOWS} windows, embargo {HORIZON}d, tau grid {TAU_GRID[0]}-{TAU_GRID[-1]}")
    agg_picked, agg_hits, agg_pos, fold_rows = 0, 0, 0, []
    for k in range(N_TEST_WINDOWS):
        ws, we = test_edges[k], test_edges[k + 1]
        train = df[df["open_time"] < ws - HORIZON * BAR_SEC]
        test = df[(df["open_time"] >= ws) & (df["open_time"] <= we)]
        if len(train) < 500 or len(test) == 0:
            continue
        learners, worst, tau, _ = fit_fold(train)
        probs = tsa1_proba(learners, worst, test[FEATURES])
        pick = probs >= tau
        y = test["label"].to_numpy()
        picked, hits = int(pick.sum()), int(y[pick].sum())
        prec = hits / picked if picked else float("nan")
        agg_picked += picked; agg_hits += hits; agg_pos += int(y.sum())
        d0 = pd.Timestamp(ws, unit="s", tz="UTC").strftime("%Y-%m")
        d1 = pd.Timestamp(we, unit="s", tz="UTC").strftime("%Y-%m")
        fold_rows.append((f"{d0}->{d1}", len(test), f"{y.mean():.1%}", tau, picked, f"{prec:.1%}" if picked else "-", worst))
        print(f"  fold {k + 1} {d0}->{d1}: test={len(test)} base={y.mean():.1%} tau={tau} "
              f"picked={picked} precision={prec:.1%} dropped={worst}" if picked else
              f"  fold {k + 1} {d0}->{d1}: test={len(test)} base={y.mean():.1%} tau={tau} picked=0")

    if agg_picked:
        overall = agg_hits / agg_picked
        ev = overall * TP_ATR - (1 - overall) * SL_ATR
        print(f"\noverall: picked {agg_picked} trades, precision {overall:.1%} "
              f"(breakeven {BREAKEVEN:.1%}), EV per trade {ev:+.2f}R-unit (fees excluded)")

    print("\nfitting final model on all data ...")
    learners, worst, tau, val_ap = fit_fold(df)
    MODEL_DIR.mkdir(exist_ok=True)
    with open(MODEL_DIR / f"model{TF_SUFFIX}.pkl", "wb") as f:
        pickle.dump({"learners": learners, "dropped": worst, "tau": tau, "features": FEATURES}, f)
    meta = {
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "timeframe": TF,
        "direction": "short", "tp_atr": TP_ATR, "sl_atr": SL_ATR, "horizon": HORIZON,
        "events": len(df), "tau": tau, "dropped_learner": worst,
        "val_average_precision": {k: round(v, 4) for k, v in val_ap.items()},
        "walk_forward": [dict(zip(["window", "n_test", "base", "tau", "picked", "precision", "dropped"], r))
                         for r in fold_rows],
    }
    (MODEL_DIR / f"meta{TF_SUFFIX}.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"saved -> {MODEL_DIR / f'model{TF_SUFFIX}.pkl'} (tau={tau}, dropped={worst})")
    print(f"saved -> {MODEL_DIR / f'meta{TF_SUFFIX}.json'}")


if __name__ == "__main__":
    main()
