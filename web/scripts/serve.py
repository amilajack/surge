#!/usr/bin/env python3
"""Development-only static server with the shared-memory isolation headers."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

class Handler(SimpleHTTPRequestHandler):
    # Reuse connections for the bootstrap scripts and worker pool instead of
    # closing a socket for every resource in Chrome's parallel startup burst.
    protocol_version = 'HTTP/1.1'
    # --cors: let a cross-origin-isolated page on another origin load these files,
    # as a Web Audio Module host does (import(), addModule, fetch and importScripts).
    cors = False
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        if self.cors:
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        else:
            self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

class Server(ThreadingHTTPServer):
    request_queue_size = 128

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', default='build-web/web')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--cors', action='store_true',
                        help='allow other origins to load files (Web Audio Module hosts)')
    args = parser.parse_args()
    Handler.cors = args.cors
    Server(('127.0.0.1', args.port), partial(Handler, directory=args.directory)).serve_forever()
