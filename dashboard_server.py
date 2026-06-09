"""Dashboard server — serves static files + CORS proxy for exchange APIs.

Run from project root:
    python3 dashboard_server.py
Then open: http://localhost:8765/dashboard/
"""
import datetime as dt
import http.server
import json
import socketserver
import urllib.parse
from pathlib import Path

import requests

PORT = 8765
ROOT = Path(__file__).parent
ANALYSIS_LOG = ROOT / "analysis_log.json"

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
        return super().do_GET()

    def do_POST(self):
        if self.path == "/api/analysis":
            return self.handle_save_analysis()
        return self.send_error(404, "unknown endpoint")

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
