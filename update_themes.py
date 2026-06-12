"""
update_themes.py — fetch theme + logo from CoinGecko for watchlist coins
Usage:
  python update_themes.py            # update all
  python update_themes.py --new-only # only coins missing from coin_meta.json
"""
import json, sys, time, pathlib, argparse, re
import requests

BASE = pathlib.Path(__file__).parent
WATCHLIST = BASE / "watchlist.json"
META_FILE = BASE / "coin_meta.json"

# Priority-ordered keyword → theme mapping (first match wins)
THEME_KEYWORDS = [
    ("artificial intelligence", "AI"), ("ai", "AI"),
    ("meme", "Meme"),
    ("gaming", "Gaming"), ("gamefi", "Gaming"), ("play-to-earn", "Gaming"), ("metaverse", "Gaming"),
    ("decentralized finance", "DeFi"), ("defi", "DeFi"), ("lending", "DeFi"), ("dex", "DeFi"), ("yield", "DeFi"),
    ("real world asset", "RWA"), ("rwa", "RWA"),
    ("layer 1", "L1"), ("layer-1", "L1"), ("smart contract platform", "L1"),
    ("depin", "DePIN"), ("infrastructure", "DePIN"), ("oracle", "DePIN"),
]

def base_symbol(sym):
    return re.sub(r"_?USDT$", "", sym, flags=re.IGNORECASE)

def detect_theme(categories):
    lower = [c.lower() for c in (categories or [])]
    for cat in lower:
        for keyword, theme in THEME_KEYWORDS:
            if keyword in cat:
                return theme
    return "Unclassified"

def cg_get(path, params=None):
    url = f"https://api.coingecko.com/api/v3{path}"
    for attempt in range(3):
        try:
            r = requests.get(url, params=params, timeout=10,
                             headers={"accept": "application/json"})
            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", 60))
                print(f"  rate limit — wait {wait}s")
                time.sleep(wait)
                continue
            r.raise_for_status()
            return r.json()
        except Exception as e:
            if attempt == 2:
                raise
            time.sleep(3)

def search_coin(query):
    data = cg_get("/search", {"query": query})
    coins = data.get("coins", [])
    q_up = query.upper()
    for c in coins:
        if c.get("symbol", "").upper() == q_up:
            return c["id"]
    return coins[0]["id"] if coins else None

def fetch_coin_detail(cg_id):
    data = cg_get(f"/coins/{cg_id}", {
        "localization": "false", "tickers": "false",
        "market_data": "false", "community_data": "false", "developer_data": "false",
    })
    logo = (data.get("image") or {}).get("small") or (data.get("image") or {}).get("thumb")
    categories = data.get("categories") or []
    return logo, [c for c in categories if c]  # drop None entries

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--new-only", action="store_true",
                    help="only process coins not already in coin_meta.json")
    args = ap.parse_args()

    watchlist = json.loads(WATCHLIST.read_text())
    tickers = watchlist.get("tickers", {})
    meta = json.loads(META_FILE.read_text()) if META_FILE.exists() else {}

    coins = [base_symbol(s) for s in tickers]
    if args.new_only:
        coins = [c for c in coins if c not in meta]

    if not coins:
        print("Nothing to update.")
        return

    changed = False
    for coin in coins:
        print(f"Looking up {coin}...", end=" ", flush=True)
        try:
            cg_id = search_coin(coin)
            if not cg_id:
                print("not found → Unclassified")
                meta[coin] = {"theme": "Unclassified", "logo_url": None, "cg_id": None, "categories": []}
                changed = True
                time.sleep(1)
                continue
            logo, categories = fetch_coin_detail(cg_id)
            theme = detect_theme(categories)
            meta[coin] = {"theme": theme, "logo_url": logo, "cg_id": cg_id, "categories": categories}
            print(f"theme={theme} logo={'✓' if logo else '✗'} (id={cg_id})")
            changed = True
            time.sleep(1.5)  # stay well under 30 calls/min free limit
        except Exception as e:
            print(f"ERROR: {e}")
            if coin not in meta:
                meta[coin] = {"theme": "Unclassified", "logo_url": None, "cg_id": None, "categories": []}
            changed = True

    if changed:
        META_FILE.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n")
        print(f"\nWrote {META_FILE} ({len(meta)} entries)")

if __name__ == "__main__":
    main()
