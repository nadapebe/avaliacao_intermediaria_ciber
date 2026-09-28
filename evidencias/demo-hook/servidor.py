#!/usr/bin/env python3
"""Servidor local da pagina de teste de hijacking do PrivacyLens.

Serve demo.html, tracker.js e injetado.js, e responde /poll. Roda em 127.0.0.1
(acessivel tambem como localhost). Nao guarda nem processa nenhum dado.
"""
import http.server
import os

PORTA = 8089
PASTA = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=PASTA, **k)

    def end_headers(self):
        # libera o carregamento entre localhost e 127.0.0.1 (primeira x terceira parte)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        if self.path.split('?')[0] == '/poll':
            corpo = b'{"ok":true}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(corpo)))
            self.end_headers()
            self.wfile.write(corpo)
            return
        super().do_GET()

    def log_message(self, *a):
        pass  # silencioso


if __name__ == '__main__':
    servidor = http.server.ThreadingHTTPServer(('127.0.0.1', PORTA), Handler)
    print('Servidor da demo em http://localhost:%d/demo.html  (Ctrl+C para parar)' % PORTA)
    servidor.serve_forever()
