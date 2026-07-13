"""Append a div-watch event (armed/confirmed/flip) dispatched by the Cloudflare Worker
(cf_worker/src/index.ts::dispatchDivJournal) to divwatch_log.json.

Fired via repository_dispatch (type div_journal) from .github/workflows/div-journal.yml,
which puts the client_payload JSON into env PAYLOAD. Dedupe by a deterministic id
(stage+symbol+source+anchor timestamp) so a re-dispatched event never double-appends.

Usage:
    PAYLOAD='{"stage":"armed",...}' python3 divwatch_journal.py
"""
import json
import os
from pathlib import Path

LOG_FILE = Path(__file__).parent / "divwatch_log.json"


def build_id(p: dict) -> str:
    anchor = p["armed_ts"] if p["stage"] == "confirmed" else p["ts"]
    return f"{p['stage']}:{p['symbol']}:{p['source']}:{anchor}"


def main() -> None:
    payload = json.loads(os.environ["PAYLOAD"])
    log = json.loads(LOG_FILE.read_text()) if LOG_FILE.exists() else {"events": []}
    events = log["events"]

    event = dict(payload)
    event["id"] = build_id(payload)
    event["status"] = "pending" if payload["stage"] == "confirmed" else "logged"

    if any(e["id"] == event["id"] for e in events):
        print(f"duplicate id {event['id']} — skip")
        return

    events.append(event)
    LOG_FILE.write_text(json.dumps(log, indent=2, ensure_ascii=False) + "\n")
    print(f"appended {event['id']}")


if __name__ == "__main__":
    main()
