"""สรุปผลรายสัปดาห์ → Telegram — รวม Reversal (ML paper trades) + Trigger Journal.

รัน 1 ครั้ง/สัปดาห์ (จันทร์เช้า) ผ่าน weekly-summary.yml ที่ CF Worker ยิง.
สรุป "7 วันล่าสุด" (ไม้/trigger ที่ปิดในช่วงนั้น) + ตัวเลขสะสมทั้งหมดเป็น context.

Usage:
    python3 weekly_summary.py            # ส่ง Telegram
    DRY_RUN=1 python3 weekly_summary.py  # print เฉย ๆ ไม่ส่ง
"""
import datetime as dt
import json
from pathlib import Path

from scan import send_telegram  # handles DRY_RUN + BOT_TOKEN/CHAT_ID

ROOT = Path(__file__).parent
PAPER_FILE = ROOT / "paper_trades.json"
TRIGGER_LOG = ROOT / "trigger_log.json"
WINDOW_DAYS = 7


def _load(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return {}


def _closed_since(items: list, cutoff: dt.datetime) -> list:
    """Items with a closed_at timestamp at/after cutoff."""
    out = []
    for it in items:
        ca = it.get("closed_at")
        if not ca:
            continue
        try:
            if dt.datetime.fromisoformat(ca) >= cutoff:
                out.append(it)
        except ValueError:
            continue
    return out


def _r_stats(rs: list[float]) -> tuple[int, int, float, float]:
    n = len(rs)
    hits = sum(1 for r in rs if r > 0)
    total = sum(rs)
    return n, hits, total, (total / n if n else 0.0)


def reversal_section(cutoff: dt.datetime) -> list[str]:
    book = _load(PAPER_FILE)
    trades = book.get("trades", [])
    closed = [t for t in trades if t.get("status", "").startswith("closed_")]
    open_n = sum(1 for t in trades if t.get("status") == "open")
    week = _closed_since(closed, cutoff)

    lines = ["🧠 <b>Reversal (ML paper)</b>"]
    if week:
        n, hits, total, avg = _r_stats([t.get("r", 0) for t in week])
        lines.append(f"  ปิด {n} ไม้ · hit {hits}/{n} ({hits/n:.0%}) · รวม {total:+.2f}R (avg {avg:+.2f}R)")
        big = [t.get("r", 0) for t in week if t.get("breadth", 0) >= 5]
        if big:
            _, _, _, avg_big = _r_stats(big)
            lines.append(f"  🔥 breadth≥5: {len(big)} ไม้ · avg {avg_big:+.2f}R")
    else:
        lines.append("  — ไม่มีไม้ปิดสัปดาห์นี้")
    if closed:
        cn, ch, ct, _ = _r_stats([t.get("r", 0) for t in closed])
        lines.append(f"  <i>สะสม: {cn} ปิด · hit {ch/cn:.0%} · {ct:+.2f}R · เปิดอยู่ {open_n}</i>")
    return lines


def trigger_section(cutoff: dt.datetime) -> list[str]:
    log = _load(TRIGGER_LOG)
    events = log.get("events", [])
    closed = [e for e in events if e.get("status", "").startswith("closed_")]
    pending = sum(1 for e in events if e.get("status") == "pending")
    week = _closed_since(closed, cutoff)

    lines = ["📋 <b>Trigger Journal</b>"]
    if week:
        n, hits, total, avg = _r_stats([e.get("r", 0) for e in week])
        lines.append(f"  ปิด {n} · hit {hits}/{n} ({hits/n:.0%}) · avg {avg:+.2f}R")
        by_type: dict[str, list] = {}
        for e in week:
            by_type.setdefault(e["type"], []).append(e.get("r", 0))
        for t, rs in sorted(by_type.items(), key=lambda kv: -sum(kv[1]) / len(kv[1])):
            tn, th, _, ta = _r_stats(rs)
            lines.append(f"    {t:<14} n{tn} · {th/tn:.0%} · {ta:+.2f}R")
    else:
        lines.append("  — ไม่มี trigger ปิดสัปดาห์นี้")
    lines.append(f"  <i>pending {pending} รายการ</i>")
    if closed:
        cn, ch, _, ca = _r_stats([e.get("r", 0) for e in closed])
        lines.append(f"  <i>สะสม: {cn} ปิด · hit {ch/cn:.0%} · avg {ca:+.2f}R</i>")
    return lines


def main() -> None:
    now = dt.datetime.now(dt.timezone.utc)
    cutoff = now - dt.timedelta(days=WINDOW_DAYS)
    header = [
        "📊 <b>สรุปรายสัปดาห์</b>",
        f"<i>{cutoff:%d %b} – {now:%d %b %Y} (7 วัน)</i>",
        "",
    ]
    body = reversal_section(cutoff) + [""] + trigger_section(cutoff)
    send_telegram("\n".join(header + body))
    print("weekly summary sent")


if __name__ == "__main__":
    main()
