"""Dashboard server — serves static files + CORS proxy for exchange APIs.

Run from project root:
    python3 dashboard_server.py
Then open: http://localhost:8765/dashboard/
"""
import datetime as dt
import http.server
import json
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

# ML pipeline runner — scripts need the local venv (sklearn/pyarrow), not Actions' python
_VENV_PY = ROOT / ".venv" / "bin" / "python3"
PYTHON = str(_VENV_PY) if _VENV_PY.exists() else sys.executable
ML_ACTIONS = {
    "fetch": lambda sym: [PYTHON, "fetch_data.py", sym],
    "universe": lambda sym: [PYTHON, "fetch_data.py", "--universe", "150"],
    "features": lambda sym: [PYTHON, "build_features.py"],
    "train": lambda sym: [PYTHON, "train_model.py"],
    "backtest": lambda sym: [PYTHON, "backtest.py"],
}
_run_lock = threading.Lock()
_run: dict = {"proc": None, "action": None, "symbol": None, "log": None, "started": None, "finished": None}


def _now_bkk() -> str:
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=7))).isoformat(timespec="seconds")

ALLOWED_HOSTS = {
    "api.gateio.ws",
    "fapi.binance.com",
    "data-api.binance.vision",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if self.path.startswith("/proxy?"):
            return self.handle_proxy()
        if self.path.startswith("/api/run/status"):
            return self.handle_run_status()
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
            if action not in ML_ACTIONS:
                raise ValueError(f"unknown action: {action}")
            if action == "fetch" and not re.fullmatch(r"[A-Z0-9_]{2,20}", symbol):
                raise ValueError("fetch requires a valid symbol")
        except Exception as e:
            return self._send_json({"ok": False, "error": str(e)}, 400)

        with _run_lock:
            if _run["proc"] is not None and _run["proc"].poll() is None:
                return self._send_json({"ok": False, "error": f"busy: {_run['action']} is running"}, 409)
            log_path = ROOT / "data" / f"run_{action}.log"
            log_path.parent.mkdir(exist_ok=True)
            logf = open(log_path, "w")
            proc = subprocess.Popen(ML_ACTIONS[action](symbol), cwd=ROOT, stdout=logf, stderr=subprocess.STDOUT)
            _run.update(proc=proc, action=action, symbol=symbol or None, log=log_path,
                        started=_now_bkk(), finished=None)

            def _wait():
                proc.wait()
                logf.close()
                _run["finished"] = _now_bkk()

            threading.Thread(target=_wait, daemon=True).start()
        return self._send_json({"ok": True, "action": action, "symbol": symbol or None})

    def handle_run_status(self):
        with _run_lock:
            proc = _run["proc"]
            if proc is None:
                state = "idle"
            elif proc.poll() is None:
                state = "running"
            else:
                state = "done" if proc.returncode == 0 else "error"
            tail = ""
            if _run["log"] and Path(_run["log"]).exists():
                raw = Path(_run["log"]).read_bytes()
                tail = raw[-3000:].decode(errors="replace")
            return self._send_json({
                "state": state, "action": _run["action"], "symbol": _run["symbol"],
                "started": _run["started"], "finished": _run["finished"],
                "returncode": proc.returncode if proc is not None else None, "tail": tail,
            })

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
            self.send_header("Cache-Control", "no-store")
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
