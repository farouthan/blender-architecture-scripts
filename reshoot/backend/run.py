#!/usr/bin/env python3
"""Start the re-shoot server.

    python run.py                # http://0.0.0.0:8000
    python run.py --port 8443 --cert cert.pem --key key.pem

The phone camera in step 5 needs a secure context, so pass --cert/--key (or put
the app behind a TLS proxy) when you want to use a phone as the camera.
"""

from __future__ import annotations

import argparse

import uvicorn

from reshoot.config import ensure_dirs


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", action="store_true")
    parser.add_argument("--cert", help="TLS certificate, needed for phone motion access")
    parser.add_argument("--key", help="TLS private key")
    args = parser.parse_args()

    ensure_dirs()
    uvicorn.run(
        "reshoot.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        ssl_certfile=args.cert,
        ssl_keyfile=args.key,
    )


if __name__ == "__main__":
    main()
