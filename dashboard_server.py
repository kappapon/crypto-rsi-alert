"""Dashboard server — serves static files + CORS proxy for exchange APIs.

Run from project root:
    python3 dashboard_server.py
Then open: http://localhost:8765/dashboard/
"""
import datetime as dt
import http.server
import json
import os
import re
import socketserver
import subprocess
import sys
import threading
import urllib.parse
from pathlib import Path

import requests

PORT = 8765
ROOT = Path(__file__).parent
ANALYSIS_LOG = ROOT / "analysis_log.json"

# 15m divergence watcher health — proxy worker /health server-side so the token stays off the client
WORKER_HEALTH_URL = "https://crypto-rsi-webhook.kappaponpuesan.workers.dev/health"

def _health_token() -> str | None:
    tok = os.environ.get("WEBHOOK_SECRET")
    return tok.strip() if tok else None

# ML pipeline runner — scripts need the local venv (sklearn/pyarrow), not Actions' python
_VENV_PY = ROOT / ".venv" / "bin" / "python3"
PYTHON = str(_VENV_PY) if _VENV_PY.exists() else sys.executable

def _py(*args: str) -> list[str]:
    return [PYTHON, *args]


def ml_steps(action: str, symbol: str) -> list[list[str]] | None:
    """Each action = ordered list of commands (full argv), run sequentially."""
    features, train, backtest = _py("build_features.py"), _py("train_model.py"), _py("backtest.py")
    # push model ขึ้น repo ให้ reversal-alert บน Actions ใช้ — รันหลัง backtest ผ่านเท่านั้น
    push_model = [
        ["git", "add", "models/model.pkl", "models/meta.json"],
        ["git", "commit", "-m", "chore: retrain model via dashboard"],
        ["git", "pull", "--rebase"],
        ["git", "push"],
    ]
    return {
        # ปุ่ม 🧠 ML Pipeline: ดึง universe → features → train → backtest → push จบในกดเดียว
        "pipeline": [_py("fetch_data.py", "--universe", "150"), features, train, backtest, *push_model],
        # ปุ่ม 📥 บนการ์ด: ดึงเหรียญนั้น แล้ว retrain + push ทั้งชุดให้เลย
        "fetch_retrain": [_py("fetch_data.py", symbol), features, train, backtest, *push_model],
        # ปุ่ม 🗑️ บนการ์ด: ลบจริง + push ให้ workflow ฝั่ง Actions เลิก monitor ด้วย
        "remove_ticker": [
            _py("manage_watchlist.py", "remove", symbol),
            ["git", "add", "watchlist.json"],
            ["git", "commit", "-m", f"watchlist: remove {symbol} via dashboard"],
            ["git", "pull", "--rebase"],
            ["git", "push"],
        ],
        # ขั้นเดี่ยว (เผื่อเรียกผ่าน API/debug)
        "fetch": [_py("fetch_data.py", symbol)],
        "universe": [_py("fetch_data.py", "--universe", "150")],
        "features": [features],
        "train": [train],
        "backtest": [backtest],
    }.get(action)


_run_lock = threading.Lock()
_run: dict = {"state": "idle", "action": None, "symbol": None, "step": None,
              "log": None, "started": None, "finished": None, "returncode": None}


def _run_steps(steps: list[list[str]], logf) -> None:
    rc = 0
    for i, cmd in enumerate(steps, 1):
        label = cmd[1] if cmd[0] == PYTHON else " ".join(cmd[:2])
        _run["step"] = f"{i}/{len(steps)} {label}"
        logf.write(f"\n=== step {i}/{len(steps)}: {label} ===\n")
        logf.flush()
        rc = subprocess.run(cmd, cwd=ROOT, stdout=logf, stderr=subprocess.STDOUT).returncode
        if rc != 0:
            logf.write(f"\n=== step {i} FAILED (exit {rc}) — stopped ===\n")
            break
    logf.close()
    _run.update(state="done" if rc == 0 else "error", returncode=rc, finished=_now_bkk())


def _now_bkk() -> str:
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=7))).isoformat(timespec="seconds")

ALLOWED_HOSTS = {
    "api.gateio.ws",
    "fapi.binance.com",
    "data-api.binance.vision",
    "api.coingecko.com",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # static (js/css/html) เปลี่ยนบ่อย — บังคับ browser revalidate ทุกครั้ง กัน cache ค้าง
        # (เจอตอนแก้ dashboard.js แล้วหน้าไม่อัปเดตเพราะ HTML อ้างไฟล์โดยไม่มี ?v=)
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/proxy?"):
            return self.handle_proxy()
        if self.path.startswith("/api/run/status"):
            return self.handle_run_status()
        if self.path.startswith("/api/div_health"):
            return self.handle_div_health()
        return super().do_GET()

    def do_POST(self):
        if self.path == "/api/analysis":
            return self.handle_save_analysis()
        if self.path == "/api/run":
            return self.handle_run_start()
        return self.send_error(404, "unknown endpoint")

    def _send_json(self, obj: dict, code: int = 200):
        payload = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def handle_run_start(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length))
            action = body.get("action", "")
            symbol = (body.get("symbol") or "").strip().upper()
            steps = ml_steps(action, symbol)
            if steps is None:
                raise ValueError(f"unknown action: {action}")
            if action in ("fetch", "fetch_retrain", "remove_ticker") and not re.fullmatch(r"[A-Z0-9_]{2,20}", symbol):
                raise ValueError(f"{action} requires a valid symbol")
        except Exception as e:
            return self._send_json({"ok": False, "error": str(e)}, 400)

        with _run_lock:
            if _run["state"] == "running":
                return self._send_json({"ok": False, "error": f"busy: {_run['action']} is running"}, 409)
            log_path = ROOT / "data" / f"run_{action}.log"
            log_path.parent.mkdir(exist_ok=True)
            logf = open(log_path, "w")
            _run.update(state="running", action=action, symbol=symbol or None, step=None,
                        log=log_path, started=_now_bkk(), finished=None, returncode=None)
            threading.Thread(target=_run_steps, args=(steps, logf), daemon=True).start()
        return self._send_json({"ok": True, "action": action, "symbol": symbol or None, "steps": len(steps)})

    def handle_run_status(self):
        with _run_lock:
            tail = ""
            if _run["log"] and Path(_run["log"]).exists():
                raw = Path(_run["log"]).read_bytes()
                tail = raw[-3000:].decode(errors="replace")
            return self._send_json({
                "state": _run["state"], "action": _run["action"], "symbol": _run["symbol"],
                "step": _run["step"], "started": _run["started"], "finished": _run["finished"],
                "returncode": _run["returncode"], "tail": tail,
            })

    def handle_div_health(self):
        tok = _health_token()
        if not tok:
            return self._send_json({"configured": False})
        try:
            r = requests.get(WORKER_HEALTH_URL, params={"token": tok}, timeout=10,
                             headers={"User-Agent": "dashboard-proxy/1.0"})
            if r.status_code != 200:
                return self._send_json({"configured": True, "error": f"http {r.status_code}"})
            return self._send_json({"configured": True, **r.json()})
        except Exception as e:
            return self._send_json({"configured": True, "error": str(e)})

    def handle_save_analysis(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length))
            symbol = body["symbol"].strip()
            scenario = body["scenario"].strip()
            label = body.get("scenario_label", "").strip()
            text = body["text"].strip()
            if not symbol or not scenario or not text:
                raise ValueError("symbol/scenario/text required")
        except Exception as e:
            return self.send_error(400, f"bad request: {e}")

        log = {}
        if ANALYSIS_LOG.exists():
            try:
                log = json.loads(ANALYSIS_LOG.read_text())
            except json.JSONDecodeError:
                log = {}
        log[symbol] = {
            "timestamp": dt.datetime.now(dt.timezone(dt.timedelta(hours=7))).isoformat(timespec="seconds"),
            "scenario": scenario,
            "scenario_label": label,
            "text": text,
        }
        ANALYSIS_LOG.write_text(json.dumps(log, ensure_ascii=False, indent=2) + "\n")

        payload = json.dumps({"ok": True, "timestamp": log[symbol]["timestamp"]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def handle_proxy(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        target = params.get("url", [None])[0]
        if not target:
            return self.send_error(400, "missing url param")

        target_host = urllib.parse.urlparse(target).netloc
        if target_host not in ALLOWED_HOSTS:
            return self.send_error(403, f"host not allowed: {target_host}")

        try:
            resp = requests.get(target, timeout=15, headers={"User-Agent": "dashboard-proxy/1.0"})
            body = resp.content
            self.send_response(resp.status_code)
            self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_error(502, f"proxy error: {e}")


def main():
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("", PORT), Handler) as srv:
        print(f"📊 Dashboard:  http://localhost:{PORT}/dashboard/")
        print(f"🔁 Proxy:      http://localhost:{PORT}/proxy?url=...")
        print("Press Ctrl+C to stop.\n")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
