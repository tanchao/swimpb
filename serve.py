#!/usr/bin/env python3
"""Local dev server + USA Swimming BFF proxy for SwimPB.

The hosted site does not run this file. Cloudflare Pages uses `functions/`.
This server may keep one session in `.bff_session` for a single local user.
The Pages Function must not.

Usage:
    python3 serve.py [port]     # default: 8787

Authentication:
    1. In-page sign-in (`POST /api/auth/login`): completes the OIDC PKCE flow
       against `data.usaswimming.org/bff/login` and `login.usaswimming.org/Login`,
       captures `bff_auth_session`, saves it to `.bff_session` (mode 0600), and
       discards the credentials immediately.
    2. Optional auto-relogin: if `SWIMPB_USER` and `SWIMPB_PASS` are set in the
       environment or `.env`, `serve.py` automatically refreshes `.bff_session`
       whenever an upstream request returns HTTP 401.
    3. Fallback cURL paste: any request carrying `X-Bff-Session` updates
       `.bff_session` on HTTP 200.
"""

import contextlib
from html.parser import HTMLParser
import http.cookiejar
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer, _get_best_family
import json
import os
from pathlib import Path
import socket
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request

UPSTREAM = "https://data.usaswimming.org"
API_PREFIXES = (
    "/api/times/swims/",
    "/api/meet/swims/",
    "/api/person/swims/",
    "/api/common/swims/",
)
ROOT = Path(__file__).resolve().parent
SESSION_FILE = ROOT / ".bff_session"
ENV_FILE = ROOT / ".env"
_session_lock = threading.Lock()
_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
)


def load_dotenv() -> dict[str, str]:
    """Read key=value pairs from `.env` if present."""
    vals: dict[str, str] = {}
    try:
        if ENV_FILE.is_file():
            for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, v = s.split("=", 1)
                vals[k.strip()] = v.strip().strip("'\"")
    except OSError:
        pass
    return vals


def get_config(key: str) -> str:
    return os.environ.get(key, "").strip() or load_dotenv().get(key, "").strip()


def load_server_session() -> str | None:
    """Return the server-held `bff_auth_session` from env or `.bff_session`."""
    env_val = get_config("SWIMPB_BFF_SESSION")
    if env_val:
        return env_val
    try:
        if SESSION_FILE.is_file():
            val = SESSION_FILE.read_text(encoding="utf-8").strip()
            return val or None
    except OSError:
        pass
    return None


def save_server_session(token: str) -> None:
    """Persist a verified `bff_auth_session` to `.bff_session` (mode 0600)."""
    token = token.strip()
    if not token:
        return
    with _session_lock:
        try:
            current = SESSION_FILE.read_text(encoding="utf-8").strip() if SESSION_FILE.is_file() else None
            if current == token:
                return
            fd = os.open(SESSION_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(token + "\n")
        except OSError:
            pass


def clear_server_session() -> None:
    with _session_lock:
        with contextlib.suppress(OSError):
            if SESSION_FILE.is_file():
                SESSION_FILE.unlink()


def extract_refreshed_cookie(headers) -> str | None:
    """If upstream rotates `bff_auth_session` via Set-Cookie, capture the new value."""
    for raw in headers.get_all("Set-Cookie") or []:
        cookie = SimpleCookie()
        try:
            cookie.load(raw)
        except Exception:
            continue
        if "bff_auth_session" in cookie:
            val = cookie["bff_auth_session"].value
            if val:
                return val
    return None


class _LoginFormParser(HTMLParser):
    """Extract HTML <form> inputs and `.validation-summary-errors` messages."""

    def __init__(self):
        super().__init__()
        self.forms: list[dict] = []
        self._cur: dict | None = None
        self.errors: list[str] = []
        self._in_err_div = 0
        self._in_err_li = False

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if tag == "form":
            self._cur = {
                "action": d.get("action", ""),
                "method": d.get("method", "get").lower(),
                "inputs": {},
            }
            self.forms.append(self._cur)
        elif tag == "input" and self._cur is not None:
            name = d.get("name")
            if name and d.get("type", "").lower() != "submit":
                self._cur["inputs"][name] = d.get("value", "")
        elif tag == "div" and "validation-summary-errors" in d.get("class", ""):
            self._in_err_div = 1
        elif tag == "div" and self._in_err_div > 0:
            self._in_err_div += 1
        elif tag == "li" and self._in_err_div > 0:
            self._in_err_li = True

    def handle_endtag(self, tag):
        if tag == "form":
            self._cur = None
        elif tag == "li":
            self._in_err_li = False
        elif tag == "div" and self._in_err_div > 0:
            self._in_err_div -= 1

    def handle_data(self, data):
        if self._in_err_li:
            text = data.strip()
            if text:
                self.errors.append(text)


def _find_bff_cookie(cj: http.cookiejar.CookieJar) -> str | None:
    for c in cj:
        if c.name == "bff_auth_session" and c.value:
            return c.value
    return None


def usas_login(username: str, password: str) -> tuple[str | None, str | None]:
    """Perform OIDC PKCE login against USA Swimming and return (bff_session, error)."""
    username = (username or "").strip()
    if not username or not password:
        return None, "Username and password are required."

    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    opener.addheaders = [
        ("User-Agent", _USER_AGENT),
        ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
    ]

    try:
        # Step 1: Start OIDC flow at data.usaswimming.org/bff/login
        resp1 = opener.open(f"{UPSTREAM}/bff/login", timeout=20)
        login_page_url = resp1.url
        html1 = resp1.read().decode("utf-8", errors="ignore")
    except Exception as err:
        return None, f"Could not reach USA Swimming login page: {err}"

    parser1 = _LoginFormParser()
    parser1.feed(html1)
    login_form = next(
        (f for f in parser1.forms if "ReturnUrl" in f["inputs"]),
        parser1.forms[0] if parser1.forms else None,
    )
    if not login_form:
        return None, "Unexpected login page structure from USA Swimming."

    # Step 2: Submit credentials to login.usaswimming.org/Login
    post_url = urllib.parse.urljoin(login_page_url, login_form["action"] or "/Login")
    fields = dict(login_form["inputs"])
    fields["Username"] = username
    fields["Password"] = password
    fields["loginButton"] = "login"

    req2 = urllib.request.Request(
        post_url,
        data=urllib.parse.urlencode(fields).encode("utf-8"),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://login.usaswimming.org",
            "Referer": login_page_url,
        },
        method="POST",
    )
    try:
        resp2 = opener.open(req2, timeout=20)
        html2 = resp2.read().decode("utf-8", errors="ignore")
        resp2_url = resp2.url
    except urllib.error.HTTPError as err:
        html2 = err.read().decode("utf-8", errors="ignore")
        resp2_url = err.url
    except Exception as err:
        return None, f"Login submission failed: {err}"

    token = _find_bff_cookie(cj)
    if token:
        save_server_session(token)
        return token, None

    parser2 = _LoginFormParser()
    parser2.feed(html2)
    if parser2.errors:
        return None, " ".join(parser2.errors)

    # Step 3: Complete OIDC form_post callback to https://data.usaswimming.org/signin-oidc
    oidc_form = next(
        (
            f
            for f in parser2.forms
            if "signin-oidc" in f["action"] or "code" in f["inputs"] or "id_token" in f["inputs"]
        ),
        None,
    )
    if not oidc_form:
        return None, "USA Swimming rejected the sign-in (check your username/password)."

    callback_url = urllib.parse.urljoin(resp2_url, oidc_form["action"])
    req3 = urllib.request.Request(
        callback_url,
        data=urllib.parse.urlencode(oidc_form["inputs"]).encode("utf-8"),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://login.usaswimming.org",
            "Referer": resp2_url,
        },
        method="POST",
    )
    with contextlib.suppress(Exception):
        opener.open(req3, timeout=20)

    token = _find_bff_cookie(cj)
    if token:
        save_server_session(token)
        return token, None

    return None, "USA Swimming sign-in completed without issuing a session cookie."


def try_auto_relogin() -> str | None:
    """If SWIMPB_USER and SWIMPB_PASS are configured, obtain a fresh session."""
    user = get_config("SWIMPB_USER")
    pw = get_config("SWIMPB_PASS")
    if not user or not pw:
        return None
    token, _ = usas_login(user, pw)
    return token


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Avoid heuristic caching on local static files so edits show up on a plain reload.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _is_api(self) -> bool:
        return self.path.startswith(API_PREFIXES)

    def do_GET(self):
        if self._is_api():
            self._proxy("GET")
        else:
            del self.headers["If-Modified-Since"]
            del self.headers["If-None-Match"]
            super().do_GET()

    def do_POST(self):
        if self.path == "/api/auth/login":
            self._handle_login()
        elif self.path == "/api/auth/logout":
            clear_server_session()
            self._send_json(200, {"ok": True})
        elif self._is_api():
            self._proxy("POST")
        else:
            self.send_error(405, "Method Not Allowed")

    def _handle_login(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            self._send_json(400, {"ok": False, "error": "Invalid JSON body."})
            return

        token, err = usas_login(data.get("username", ""), data.get("password", ""))
        if token:
            self._send_json(200, {"ok": True, "bffSession": token})
        else:
            self._send_json(401, {"ok": False, "error": err or "Sign-in failed."})

    def _proxy(self, method: str):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length > 0 else None

        client_session = (self.headers.get("X-Bff-Session") or "").strip()
        active_session = client_session or load_server_session()

        status, content_type, payload = self._forward(method, body, active_session, client_session)
        if status == 401:
            refreshed = try_auto_relogin()
            if refreshed:
                status, content_type, payload = self._forward(method, body, refreshed, "")

        self._send(status, content_type, payload)

    def _forward(
        self, method: str, body: bytes | None, active_session: str | None, client_session: str
    ) -> tuple[int, str, bytes]:
        headers = {
            "Accept": "application/json, */*",
            "User-Agent": _USER_AGENT,
            "X-CSRF": "1",
        }
        device_id = self.headers.get("Device-Id")
        if device_id:
            headers["Device-Id"] = device_id
        content_type = self.headers.get("Content-Type")
        if content_type:
            headers["Content-Type"] = content_type
        if active_session:
            headers["Cookie"] = f"bff_auth_session={active_session}"

        req = urllib.request.Request(
            UPSTREAM + self.path,
            data=body,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                payload = resp.read()
                rotated = extract_refreshed_cookie(resp.headers)
                if rotated:
                    save_server_session(rotated)
                elif client_session and resp.status == 200:
                    save_server_session(client_session)
                return resp.status, resp.headers.get("Content-Type", "application/json"), payload
        except urllib.error.HTTPError as err:
            payload = err.read()
            return err.code, err.headers.get("Content-Type", "text/plain"), payload
        except Exception as err:
            msg = f"Upstream request failed: {err}".encode("utf-8")
            return 502, "text/plain; charset=utf-8", msg

    def _send_json(self, status: int, obj: dict):
        payload = json.dumps(obj).encode("utf-8")
        self._send(status, "application/json; charset=utf-8", payload)

    def _send(self, status: int, content_type: str, payload: bytes):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class DualStackServer(ThreadingHTTPServer):
    def server_bind(self):
        with contextlib.suppress(Exception):
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        return super().server_bind()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    DualStackServer.address_family, addr = _get_best_family(None, port)
    with DualStackServer(addr, Handler) as server:
        has_sess = "yes" if load_server_session() else "no (sign in on page or set .bff_session)"
        print(f"SwimPB serving on http://localhost:{port} (server session: {has_sess})")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down.")


if __name__ == "__main__":
    main()
