"""CLI helper for managing watchlist.json — add/remove/list/enable/disable tickers."""
import argparse
import json
import sys
from pathlib import Path

CONFIG_FILE = Path(__file__).parent / "watchlist.json"
EXCHANGES = ["binance_futures", "binance_spot", "gateio_futures"]


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        return {"settings": {"cooldown_minutes": 30, "enabled": True}, "tickers": {}}
    return json.loads(CONFIG_FILE.read_text())


def save_config(config: dict) -> None:
    CONFIG_FILE.write_text(json.dumps(config, indent=2, sort_keys=False) + "\n")


def cmd_add(args: argparse.Namespace) -> None:
    config = load_config()
    symbol = args.symbol
    if symbol in config["tickers"] and not args.force:
        sys.exit(f"❌ {symbol} มีอยู่แล้ว — ใช้ --force เพื่อ overwrite")

    levels = {}
    if args.breakout is not None:
        levels["breakout_above"] = args.breakout
    if args.resistance is not None:
        levels["resistance"] = args.resistance
    if args.rejection is not None:
        levels["rejection_below"] = args.rejection
    if args.support is not None:
        levels["support_strong"] = args.support
    if args.extreme is not None:
        levels["support_extreme"] = args.extreme

    alerts = {
        "price_breakout": "breakout_above" in levels,
        "price_rejection": "rejection_below" in levels,
        "support_break": "support_strong" in levels,
    }
    if args.funding is not None:
        alerts["funding_high"] = args.funding

    config["tickers"][symbol] = {
        "exchange": args.exchange,
        "enabled": True,
        "levels": levels,
        "alerts": alerts,
    }
    save_config(config)
    print(f"✅ Added {symbol} ({args.exchange})")
    print(f"   Levels:  {levels}")
    print(f"   Alerts:  {alerts}")


def cmd_remove(args: argparse.Namespace) -> None:
    config = load_config()
    if args.symbol not in config["tickers"]:
        sys.exit(f"❌ {args.symbol} ไม่อยู่ใน watchlist")
    del config["tickers"][args.symbol]
    save_config(config)
    print(f"🗑️  Removed {args.symbol}")


def cmd_list(args: argparse.Namespace) -> None:
    config = load_config()
    global_enabled = config.get("settings", {}).get("enabled", True)
    print(f"🌐 Global: {'🟢 ACTIVE' if global_enabled else '🔴 PAUSED'}")
    print(f"📋 Tickers ({len(config['tickers'])}):")
    if not config["tickers"]:
        print("   (empty)")
        return
    for sym, cfg in config["tickers"].items():
        status = "🟢" if cfg.get("enabled", True) else "⚫"
        levels = cfg.get("levels", {})
        level_str = " | ".join(f"{k.split('_')[0][:4]}={v}" for k, v in levels.items())
        print(f"   {status} {sym:15} [{cfg['exchange']:18}]  {level_str}")


def cmd_show(args: argparse.Namespace) -> None:
    config = load_config()
    if args.symbol not in config["tickers"]:
        sys.exit(f"❌ {args.symbol} ไม่อยู่ใน watchlist")
    print(json.dumps(config["tickers"][args.symbol], indent=2))


def _toggle_one(symbol: str, enabled: bool) -> None:
    config = load_config()
    if symbol not in config["tickers"]:
        sys.exit(f"❌ {symbol} ไม่อยู่ใน watchlist")
    config["tickers"][symbol]["enabled"] = enabled
    save_config(config)
    print(f"{'🟢 enabled' if enabled else '⚫ disabled'} {symbol}")


def cmd_enable(args: argparse.Namespace) -> None:
    _toggle_one(args.symbol, True)


def cmd_disable(args: argparse.Namespace) -> None:
    _toggle_one(args.symbol, False)


def _toggle_global(enabled: bool) -> None:
    config = load_config()
    config.setdefault("settings", {})["enabled"] = enabled
    save_config(config)
    print(f"🌐 Global: {'🟢 RESUMED' if enabled else '🔴 PAUSED'}")


def cmd_pause(args: argparse.Namespace) -> None:
    _toggle_global(False)


def cmd_resume(args: argparse.Namespace) -> None:
    _toggle_global(True)


def cmd_set(args: argparse.Namespace) -> None:
    config = load_config()
    if args.symbol not in config["tickers"]:
        sys.exit(f"❌ {args.symbol} ไม่อยู่ใน watchlist")
    ticker = config["tickers"][args.symbol]
    changed = []
    if args.breakout is not None:
        ticker["levels"]["breakout_above"] = args.breakout
        ticker["alerts"]["price_breakout"] = True
        changed.append(f"breakout_above={args.breakout}")
    if args.resistance is not None:
        ticker["levels"]["resistance"] = args.resistance
        changed.append(f"resistance={args.resistance}")
    if args.rejection is not None:
        ticker["levels"]["rejection_below"] = args.rejection
        ticker["alerts"]["price_rejection"] = True
        changed.append(f"rejection_below={args.rejection}")
    if args.support is not None:
        ticker["levels"]["support_strong"] = args.support
        ticker["alerts"]["support_break"] = True
        changed.append(f"support_strong={args.support}")
    if args.extreme is not None:
        ticker["levels"]["support_extreme"] = args.extreme
        changed.append(f"support_extreme={args.extreme}")
    if args.funding is not None:
        ticker["alerts"]["funding_high"] = args.funding
        changed.append(f"funding_high={args.funding}")
    if not changed:
        sys.exit("❌ ไม่มี field ให้แก้ — ใช้ --breakout, --rejection, --support, --funding ...")
    save_config(config)
    print(f"✏️  Updated {args.symbol}: {', '.join(changed)}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Manage watchlist.json")
    sub = p.add_subparsers(dest="command", required=True)

    p_add = sub.add_parser("add", help="เพิ่ม ticker ใหม่")
    p_add.add_argument("symbol")
    p_add.add_argument("--exchange", "-e", required=True, choices=EXCHANGES)
    p_add.add_argument("--breakout", "-b", type=float)
    p_add.add_argument("--resistance", "-r", type=float)
    p_add.add_argument("--rejection", "-j", type=float)
    p_add.add_argument("--support", "-s", type=float)
    p_add.add_argument("--extreme", "-x", type=float)
    p_add.add_argument("--funding", "-f", type=float, help="funding rate threshold %%")
    p_add.add_argument("--force", action="store_true", help="overwrite ถ้ามีแล้ว")
    p_add.set_defaults(func=cmd_add)

    p_rm = sub.add_parser("remove", aliases=["rm"], help="ลบ ticker")
    p_rm.add_argument("symbol")
    p_rm.set_defaults(func=cmd_remove)

    p_ls = sub.add_parser("list", aliases=["ls"], help="ดู watchlist ทั้งหมด")
    p_ls.set_defaults(func=cmd_list)

    p_sh = sub.add_parser("show", help="ดูรายละเอียด ticker")
    p_sh.add_argument("symbol")
    p_sh.set_defaults(func=cmd_show)

    p_en = sub.add_parser("enable", help="เปิด ticker")
    p_en.add_argument("symbol")
    p_en.set_defaults(func=cmd_enable)

    p_dis = sub.add_parser("disable", help="ปิด ticker (ไม่ลบ)")
    p_dis.add_argument("symbol")
    p_dis.set_defaults(func=cmd_disable)

    sub.add_parser("pause", help="หยุด bot ทั้งระบบ").set_defaults(func=cmd_pause)
    sub.add_parser("resume", help="กลับมาทำงานทั้งระบบ").set_defaults(func=cmd_resume)

    p_set = sub.add_parser("set", help="แก้ level/funding ของ ticker ที่มีอยู่")
    p_set.add_argument("symbol")
    p_set.add_argument("--breakout", "-b", type=float)
    p_set.add_argument("--resistance", "-r", type=float)
    p_set.add_argument("--rejection", "-j", type=float)
    p_set.add_argument("--support", "-s", type=float)
    p_set.add_argument("--extreme", "-x", type=float)
    p_set.add_argument("--funding", "-f", type=float)
    p_set.set_defaults(func=cmd_set)

    return p


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
