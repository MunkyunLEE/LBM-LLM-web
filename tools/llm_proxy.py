import argparse
import http.server
import urllib.request
import urllib.error

ap = argparse.ArgumentParser(description="LBM-LLM-web optional CORS proxy for LLM gateways that block browser calls")
ap.add_argument("target", help="upstream base URL, e.g. https://llm-gateway.example.com/v1")
ap.add_argument("--port", type=int, default=8790)
ap.add_argument("--key", default="", help="optional API key injected server-side (Authorization: Bearer)")
args = ap.parse_args()
TARGET = args.target.rstrip("/")
HOP = {"host", "origin", "referer", "content-length", "connection", "accept-encoding"}


class Proxy(http.server.BaseHTTPRequestHandler):
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def forward(self, method):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)) if method == "POST" else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        if args.key:
            headers["Authorization"] = f"Bearer {args.key}"
        req = urllib.request.Request(TARGET + self.path, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                status, data, ctype = r.status, r.read(), r.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            status, data, ctype = e.code, e.read(), e.headers.get("Content-Type", "text/plain")
        except Exception as e:
            status, data, ctype = 502, str(e).encode(), "text/plain"
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        self.forward("POST")

    def do_GET(self):
        self.forward("GET")


print(f"LLM proxy: http://127.0.0.1:{args.port}  ->  {TARGET}")
print(f"LBM-LLM-web 엔드포인트 칸에 http://127.0.0.1:{args.port} 를 입력하세요")
http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Proxy).serve_forever()
