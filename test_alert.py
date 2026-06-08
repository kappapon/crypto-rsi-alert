"""Send a one-off test alert with inline buttons — verify scan.py → handler pipeline.

ใช้ผ่าน workflow_dispatch ที่ test-alert.yml (ไม่ต้องใส่ BOT_TOKEN local)
ค่า env SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT (default) เปลี่ยนได้ผ่าน workflow input
"""
import os
import sys

from scan import _build_keyboard, send_telegram

SYMBOLS = os.environ.get("SYMBOLS", "BTCUSDT,ETHUSDT,SOLUSDT").split(",")


def main() -> None:
    syms = [s.strip().upper() for s in SYMBOLS if s.strip()]
    if not syms:
        sys.exit("ERROR: SYMBOLS empty")

    lines = [
        "🧪 <b>TEST Alert — Interactive Button</b>",
        "",
        "ทดสอบปุ่ม ➕ Add to Watchlist",
        "",
        "📋 Sample tickers:",
    ]
    for s in syms:
        lines.append(f"  <code>{s}</code>")
    lines.append("")
    lines.append("👇 กด ➕ เพื่อเพิ่มเข้า watchlist (handler รอบถัดไป */5 นาที จะ commit)")

    send_telegram("\n".join(lines), reply_markup=_build_keyboard(syms))
    print(f"✅ Sent test alert with buttons: {', '.join(syms)}")


if __name__ == "__main__":
    main()
