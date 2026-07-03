"""Cross-language parity test — classify() ใน pattern_scan.py ต้อง match
classifyPattern() ใน dashboard/dashboard.js เป๊ะๆ (ports ต้องตรงกันเสมอ).

ดึง source ของ ema()/classifyPattern() จาก dashboard.js สดๆ มารันผ่าน node แล้ว
เทียบผลกับ pattern_scan.classify() บน fixture เดียวกัน ป้องกันไม่ให้สอง
ฝั่งดริฟท์ออกจากกันโดยไม่มีใครรู้

Usage:
    python3 test_pattern_parity.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from pattern_scan import classify

ROOT = Path(__file__).parent
DASHBOARD_JS = ROOT / "dashboard" / "dashboard.js"


def flat(price, n):
    return [{"o": price, "h": price, "c": price} for _ in range(n)]


def build_f3_pullback():
    """47 แท่งเขียวไต่ขึ้นทีละ 3 (o=prev close, h=close+1) ตามด้วย 3 แท่งแดงเล็กๆ."""
    bars = []
    cur_c = 100
    for i in range(47):
        o = cur_c if i > 0 else 100
        c = o + 3
        h = c + 1
        bars.append({"o": o, "h": h, "c": c})
        cur_c = c
    for _ in range(3):
        prev_c = bars[-1]["c"]
        bars.append({"o": prev_c, "h": prev_c, "c": prev_c - 1})
    return bars


def build_f4_downtrend():
    """25 แท่ง flat ที่ 100 ตามด้วย 25 แท่งไต่ลงทีละ 1 (o=h=prev close)."""
    bars = flat(100, 25)
    cur = 100
    for _ in range(25):
        c = cur - 1
        bars.append({"o": cur, "h": cur, "c": c})
        cur = c
    return bars


FIXTURES = [
    {
        "name": "F1 parabolic",
        "candles": flat(100, 46) + [
            {"o": 100, "h": 200, "c": 150},
            {"o": 150, "h": 210, "c": 170},
            {"o": 170, "h": 220, "c": 185},
            {"o": 185, "h": 230, "c": 200},
        ],
        "expected": "Parabolic",  # last far above ema20*1.15, 4 greens in last 4
    },
    {
        "name": "F2 breakout",
        "candles": flat(100, 49) + [{"o": 100, "h": 105, "c": 105}],
        "expected": "Breakout",  # 105 > 20-bar high 100; Parabolic fails
    },
    {
        "name": "F3 pullback",
        "candles": build_f3_pullback(),
        "expected": "Pullback",  # last > ema50, >=2 red in last 3, last <= high20
    },
    {
        "name": "F4 downtrend",
        "candles": build_f4_downtrend(),
        "expected": "Downtrend",
    },
    {
        "name": "F5 range",
        "candles": flat(100, 50),
        "expected": "Range",  # pins ties ema20==ema50 and last==high20 falling through
    },
    {
        "name": "F6 guard",
        "candles": flat(100, 49),
        "expected": None,  # length < 50 -> null/None on both sides
    },
    {
        "name": "F7 breakout-tie",
        "candles": flat(100, 49) + [{"o": 100, "h": 100, "c": 100}],
        "expected": "Range",  # last == high20 must NOT breakout (strict >)
    },
    {
        "name": "F8 parabolic-threshold",
        "candles": flat(100, 49) + [{"o": 100, "h": 115, "c": 115}],
        "expected": "Breakout",  # big jump alone (only 1 green in last 4) is Breakout, not Parabolic
    },
]


def extract_js_function(src: str, signature: str) -> str:
    """ดึง source เต็มของฟังก์ชันด้วย brace-matching เริ่มจาก { แรกหลัง signature."""
    start = src.index(signature)
    brace_start = src.index("{", start)
    depth = 0
    i = brace_start
    while i < len(src):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[start:i + 1]
        i += 1
    raise ValueError(f"unbalanced braces extracting {signature!r}")


def run_python():
    results = []
    for f in FIXTURES:
        opens = [c["o"] for c in f["candles"]]
        highs = [c["h"] for c in f["candles"]]
        closes = [c["c"] for c in f["candles"]]
        results.append(classify(opens, highs, closes))
    return results


def run_node():
    src = DASHBOARD_JS.read_text(encoding="utf-8")
    ema_src = extract_js_function(src, "function ema(")
    classify_src = extract_js_function(src, "function classifyPattern(")

    driver = (
        ema_src
        + "\n"
        + classify_src
        + """
const fs = require("fs");
const fixtures = JSON.parse(fs.readFileSync(0, "utf8"));
const out = fixtures.map(f => { const p = classifyPattern(f); return p ? p.name : null; });
console.log(JSON.stringify(out));
"""
    )

    with tempfile.NamedTemporaryFile(mode="w", suffix=".js", delete=False, encoding="utf-8") as tmp:
        tmp.write(driver)
        tmp_path = tmp.name

    proc = subprocess.run(
        ["node", tmp_path],
        input=json.dumps([f["candles"] for f in FIXTURES]),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        # เก็บ temp file ไว้ debug ตอน fail
        sys.exit(f"ERROR: node driver failed (see {tmp_path}):\n{proc.stderr}")
    os.unlink(tmp_path)
    return json.loads(proc.stdout)


def main() -> None:
    if shutil.which("node") is None:
        print("SKIP: node not found on PATH — cannot run JS parity check")
        sys.exit(0)

    python_results = run_python()
    node_results = run_node()

    failures = 0
    for f, py, js in zip(FIXTURES, python_results, node_results):
        expected = f["expected"]
        ok = expected == py == js
        status = "PASS" if ok else "FAIL"
        print(f"{status}  {f['name']}: expected={expected} python={py} node={js}")
        if not ok:
            failures += 1

    total = len(FIXTURES)
    print(f"\n{total - failures}/{total} fixtures passed")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
