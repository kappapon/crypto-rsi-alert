"""Theme snapshot — เก็บ market cap รายธีมจาก CoinGecko categories ลง theme_history.json

เพื่อให้ dashboard คำนวณ % เปลี่ยนแปลง 1D/2D/1W/1M แบบ client-side ได้ (Phase E2
ของ DASHBOARD_V3_PLAN.md). แต่ละธีมเก็บค่า market_cap ของ category ที่ market_cap
มากสุดในธีมนั้น เขียนทับค่าของวันนี้ (UTC) ทุกครั้งที่รัน — รันวันละหลายรอบแต่เก็บ
ค่าเดียวต่อวัน (ครั้งล่าสุดชนะ)

Usage:
    python3 theme_snapshot.py           # เขียนไฟล์
    DRY_RUN=1 python3 theme_snapshot.py # print อย่างเดียว
"""
import datetime as dt
import json
import os
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).parent
OUT_FILE = ROOT / "theme_history.json"
KEEP_DAYS = 35  # เก็บประวัติย้อนหลังกี่วัน
DRY_RUN = os.environ.get("DRY_RUN") == "1"


def cg_category_to_theme(category_id: str) -> str | None:
    """จับคู่ CoinGecko category id -> ธีม

    กติกาต้องตรงกับ cgCategoryToTheme ใน dashboard/dashboard.js เสมอ —
    แก้ที่นั่นต้องแก้ที่นี่.
    """
    s = category_id.lower()
    if "artificial-intelligence" in s:
        return "AI"
    if "meme" in s:
        return "Meme"
    if "gaming" in s or "gamefi" in s or "play-to-earn" in s:
        return "Gaming"
    if "decentralized-finance" in s or "-defi" in s:
        return "DeFi"
    if "real-world-asset" in s or "-rwa" in s:
        return "RWA"
    if "layer-1" in s or "smart-contract-platform" in s:
        return "L1"
    if "depin" in s:
        return "DePIN"
    return None


def best_market_cap_per_theme(categories: list[dict]) -> dict[str, int]:
    """ต่อธีม เก็บ category ที่ market_cap มากสุด (mirror ของ bestCategoryPerTheme)."""
    best: dict[str, float] = {}
    for cat in categories:
        theme = cg_category_to_theme(cat.get("id", ""))
        if not theme:
            continue
        market_cap = cat.get("market_cap")
        if market_cap is None:
            continue
        if theme not in best or market_cap > best[theme]:
            best[theme] = market_cap
    return {theme: round(mc) for theme, mc in best.items()}


def main() -> None:
    try:
        resp = requests.get("https://api.coingecko.com/api/v3/coins/categories", timeout=30)
        resp.raise_for_status()
        categories = resp.json()
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)

    values = best_market_cap_per_theme(categories)

    old = {}
    if OUT_FILE.exists():
        try:
            old = json.loads(OUT_FILE.read_text())
        except json.JSONDecodeError:
            pass

    days: dict[str, dict] = old.get("days", {})
    today = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    days[today] = values

    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
    days = {d: v for d, v in days.items() if d >= cutoff}

    out = {
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "days": days,
    }

    for theme, market_cap in values.items():
        print(f"{theme}: {market_cap}")
    print(f"summary: {len(values)} themes, {len(days)} days retained")

    if DRY_RUN:
        print("[DRY_RUN] no write")
        return
    OUT_FILE.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n")
    print(f"wrote {OUT_FILE.name}")


if __name__ == "__main__":
    main()
