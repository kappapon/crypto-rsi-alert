"""Write a single analysis entry to analysis_log.json — used by /loop monitoring task.

Usage:
    python3 log_analysis.py BEAT_USDT C "choppy ใกล้ขอบบน" "Drop 4.35 → 4.29..."
"""
import datetime as dt
import json
import sys
from pathlib import Path

LOG_FILE = Path(__file__).parent / "analysis_log.json"


def main() -> None:
    if len(sys.argv) < 5:
        sys.exit("usage: log_analysis.py <symbol> <scenario> <label> <text>")
    symbol, scenario, label, text = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

    log = {}
    if LOG_FILE.exists():
        try:
            log = json.loads(LOG_FILE.read_text())
        except json.JSONDecodeError:
            log = {}

    log[symbol] = {
        "timestamp": dt.datetime.now(dt.timezone(dt.timedelta(hours=7))).isoformat(timespec="seconds"),
        "scenario": scenario,
        "scenario_label": label,
        "text": text,
    }
    LOG_FILE.write_text(json.dumps(log, ensure_ascii=False, indent=2) + "\n")
    print(f"✅ {symbol} @ {log[symbol]['timestamp']} → {scenario}")


if __name__ == "__main__":
    main()
