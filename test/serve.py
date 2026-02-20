#!/usr/bin/env python3
"""Serve test files with COOP/COEP headers required for SharedArrayBuffer."""
import http.server
import os
import sys

PORT = 8080

class COOPCOEPHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

os.chdir(os.path.dirname(os.path.abspath(__file__)) + "/..")
print(f"Serving from {os.getcwd()} on http://localhost:{PORT}")
print(f"Open: http://localhost:{PORT}/test/test.html")
httpd = http.server.HTTPServer(("", PORT), COOPCOEPHandler)
httpd.serve_forever()
