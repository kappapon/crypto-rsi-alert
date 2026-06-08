"""Poll Telegram for inline-button presses → auto-add ticker to watchlist.

ใช้คู่กับปุ่ม "➕ SYMBOL" ที่ scan.py ฝังในข้อความ alert
- callback_data รูปแบบ "add:SYMBOL" → run `manage_watchlist.py suggest SYMBOL --yes`
- last_update_id เก็บใน telegram_state.json (commit กลับ repo)
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).parent
STATE_FILE = ROOT / "telegram_state.json"
WATCHLIST_FILE = ROOT / "watchlist.json"
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
DRY_RUN = os.environ.get("DRY_RUN") == "1"
API = f"https://api.telegram.org/bot{BOT_TOKEN}"


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {"last_update_id": 0}
    try:
        return json.loads(STATE_FILE.read_text())
    except json.JSONDecodeError:
        return {"last_update_id": 0}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2) + "\n")


def get_updates(offset: int) -> list[dict]:
    r = requests.get(
        f"{API}/getUpdates",
        params={
            "offset": offset,
            "timeout": 0,
            "allowed_updates": json.dumps(["callback_query"]),
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("result", [])


def answer_callback(callback_id: str, text: str, alert: bool = False) -> None:
    if DRY_RUN:
        print(f"  [dry-run] answer {callback_id}: {text}")
        return
    try:
        requests.post(
            f"{API}/answerCallbackQuery",
            json={"callback_query_id": callback_id, "text": text, "show_alert": alert},
            timeout=10,
        )
    except Exception as e:
        print(f"  answer_callback err: {e}", file=sys.stderr)


def edit_message_text(chat_id: int, message_id: int, text: str) -> None:
    """Append confirmation to the original alert message and strip its buttons."""
    if DRY_RUN:
        print(f"  [dry-run] edit msg {chat_id}/{message_id}")
        return
    try:
        requests.post(
            f"{API}/editMessageText",
            json={
                "chat_id": chat_id,
                "message_id": message_id,
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            },
            timeout=10,
        )
    except Exception as e:
        print(f"  edit_message err: {e}", file=sys.stderr)


def run_suggest(symbol: str) -> tuple[bool, str]:
    """Run `manage_watchlist.py suggest <symbol> --yes`. Returns (ok, output)."""
    result = subprocess.run(
        [sys.executable, "manage_watchlist.py", "suggest", symbol, "--yes"],
        capture_output=True,
        text=True,
        cwd=ROOT,
        timeout=60,
    )
    output = (result.stdout + result.stderr).strip()
    return result.returncode == 0, output


def main() -> None:
    if not BOT_TOKEN:
        sys.exit("ERROR: BOT_TOKEN not set")

    state = load_state()
    offset = state["last_update_id"] + 1
    updates = get_updates(offset)
    print(f"[handler] fetched {len(updates)} updates (offset={offset})")

    added: list[str] = []
    processed: set[str] = set()
    for upd in updates:
        state["last_update_id"] = upd["update_id"]
        cb = upd.get("callback_query")
        if not cb:
            continue
        data = cb.get("data", "")
        if not data.startswith("add:"):
            continue
        symbol = data[4:].strip()
        msg = cb.get("message") or {}
        chat_id = msg.get("chat", {}).get("id")
        message_id = msg.get("message_id")
        callback_id = cb["id"]

        print(f"[handler] add request: {symbol}")
        if not symbol:
            answer_callback(callback_id, "❌ Invalid symbol")
            continue
        if symbol in processed:
            print(f"  duplicate click on {symbol} — skip suggest")
            answer_callback(callback_id, f"⏭️ {symbol} กำลังเพิ่มแล้ว")
            continue
        processed.add(symbol)

        ok, out = run_suggest(symbol)
        last_line = out.splitlines()[-1] if out else ""
        if ok:
            answer_callback(callback_id, f"✅ {symbol} added")
            added.append(symbol)
            if chat_id and message_id:
                # ผนวก confirmation ท้ายข้อความเดิม (สั้น ๆ)
                original = msg.get("text", "")
                appended = original + f"\n\n✅ <code>{symbol}</code> added to watchlist"
                edit_message_text(chat_id, message_id, appended)
        else:
            answer_callback(callback_id, f"❌ {symbol}: {last_line[:150]}", alert=True)
            print(f"  suggest failed:\n{out}", file=sys.stderr)

    save_state(state)
    if added:
        print(f"[handler] added: {', '.join(added)}")
    else:
        print("[handler] no actions taken")


if __name__ == "__main__":
    main()
