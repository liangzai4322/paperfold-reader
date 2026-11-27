import argparse
from contextlib import contextmanager
from hashlib import sha256
from hmac import compare_digest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import parse_qs, urlsplit
from uuid import NAMESPACE_URL, uuid4, uuid5


ROOT = "/paperfold-api"
BOOKS = ROOT + "/v1/books"
MAX_BODY = 8 * 1024 * 1024
META = "id,title,format,bytes,created_at AS createdAt,pos_offset AS offset,progress_at AS progressAt"
BOOK_ID = re.compile(r"[a-zA-Z0-9._-]{4,120}")
FORMATS = ("plain", "markdown", "auto")
DEFAULT_ORIGINS = (
    "https://liangzai4322.github.io", "https://appassets.androidplatform.net",
)


class ApiError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def milliseconds():
    return time.time_ns() // 1_000_000


def number(value, limit):
    if type(value) is not int or not 0 <= value <= limit:
        raise ApiError(400, "invalid_number")
    return value


def book_fields(data):
    text = data.get("text")
    title = data.get("title")
    format = data.get("format", "auto")
    if not isinstance(text, str) or not text.strip() or format not in FORMATS:
        raise ApiError(400, "invalid_book")
    if title is None or title == "":
        title = next((line.strip() for line in text.splitlines() if line.strip()), "未命名")
        title = re.sub(r"^#{1,6}\s+", "", title)
    if not isinstance(title, str):
        raise ApiError(400, "invalid_title")
    title = (" ".join(title.split()) or "未命名")[:120]
    try:
        size = len(text.encode("utf-8"))
        title.encode("utf-8")
    except UnicodeEncodeError:
        raise ApiError(400, "invalid_text_encoding") from None
    return title, text, format, size


class SyncServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, path, sync_token, ingest_token, origins=DEFAULT_ORIGINS):
        if len(sync_token) < 32 or len(ingest_token) < 32 or sync_token == ingest_token:
            raise ValueError("Set distinct device and import tokens of at least 32 characters")
        self.path = path
        self.sync_digest = sha256(sync_token.encode()).digest()
        self.ingest_digest = sha256(ingest_token.encode()).digest()
        self.origins = set(origins)
        with self.database() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""
                CREATE TABLE IF NOT EXISTS books (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
                    format TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL,
                    pos_offset INTEGER NOT NULL DEFAULT 0, progress_at INTEGER NOT NULL DEFAULT 0
                )
            """)
        super().__init__(address, SyncRequest)

    @contextmanager
    def database(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()


class SyncRequest(BaseHTTPRequestHandler):
    server_version = "PaperfoldSync/1"

    def log_message(self, message, *args):
        pass

    def reply(self, status, value=None):
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode() if value is not None else b""
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Vary", "Origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self.headers.get("Origin")
        if origin in self.server.origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization,Content-Type,Idempotency-Key")
            self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def require_token(self, allows_ingest):
        prefix, _, token = self.headers.get("Authorization", "").partition(" ")
        digest = sha256(token.encode()).digest()
        if prefix == "Bearer" and compare_digest(digest, self.server.sync_digest):
            return
        if prefix == "Bearer" and compare_digest(digest, self.server.ingest_digest):
            if allows_ingest:
                return
            raise ApiError(403, "import_only")
        raise ApiError(401, "invalid_token")

    def body(self):
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError(400, "invalid_length") from None
        if size > MAX_BODY:
            raise ApiError(413, "book_too_large")
        if size < 1 or self.headers.get_content_type() != "application/json":
            raise ApiError(400, "expected_json")
        self.connection.settimeout(20)
        try:
            data = json.loads(self.rfile.read(size))
        except (UnicodeError, ValueError, TimeoutError):
            raise ApiError(400, "invalid_json") from None
        if not isinstance(data, dict):
            raise ApiError(400, "expected_object")
        return data

    def list_books(self, query):
        after = parse_qs(query).get("after", [""])[0]
        if after and not BOOK_ID.fullmatch(after):
            raise ApiError(400, "invalid_cursor")
        with self.server.database() as db:
            rows = db.execute(f"SELECT {META} FROM books WHERE id>? ORDER BY id LIMIT 101", (after,)).fetchall()
        return {"books": [dict(row) for row in rows[:100]], "next": rows[99]["id"] if len(rows) > 100 else None}

    def get_book(self, book_id):
        with self.server.database() as db:
            row = db.execute(f"SELECT {META}, body AS text FROM books WHERE id=?", (book_id,)).fetchone()
        if row is None:
            raise ApiError(404, "book_not_found")
        return dict(row)

    def put_book(self, book_id, data):
        title, body, format, size = book_fields(data)
        created_at = number(data.get("createdAt", milliseconds()), 2**53 - 1)
        with self.server.database() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute(
                "SELECT title,body,format FROM books WHERE id=?", (book_id,)
            ).fetchone()
            if previous and tuple(previous) != (title, body, format):
                raise ApiError(409, "book_id_conflict")
            if not previous:
                db.execute("INSERT INTO books (id,title,body,format,bytes,created_at) VALUES (?,?,?,?,?,?)",
                           (book_id, title, body, format, size, created_at))
            row = db.execute(f"SELECT {META} FROM books WHERE id=?", (book_id,)).fetchone()
        return (200 if previous else 201), dict(row)

    def update_progress(self, book_id, data):
        offset = number(data.get("offset"), MAX_BODY)
        updated = number(data.get("progressAt"), 2**53 - 1)
        with self.server.database() as db:
            db.execute(
                """UPDATE books SET pos_offset=?,progress_at=? WHERE id=?
                   AND (progress_at < ? OR (progress_at = ? AND pos_offset < ?))""",
                (offset, updated, book_id, updated, updated, offset),
            )
            row = db.execute(f"SELECT {META} FROM books WHERE id=?", (book_id,)).fetchone()
        if row is None:
            raise ApiError(404, "book_not_found")
        return dict(row)

    def route(self):
        target = urlsplit(self.path)
        path, method = target.path, self.command
        origin = self.headers.get("Origin")
        if origin and origin not in self.server.origins:
            raise ApiError(403, "origin_not_allowed")
        if method == "OPTIONS" and (path == BOOKS or path.startswith(BOOKS + "/")):
            return 204, None
        if path == ROOT + "/healthz" and method == "GET":
            return 200, {"ok": True}
        if path == BOOKS:
            self.require_token(method == "POST")
            if method == "GET":
                return 200, self.list_books(target.query)
            if method == "POST":
                key = self.headers.get("Idempotency-Key", "")
                if key and (len(key) > 160 or not key.isascii()):
                    raise ApiError(400, "invalid_idempotency_key")
                book_id = str(uuid5(NAMESPACE_URL, "paperfold-import:" + key) if key else uuid4())
                status, book = self.put_book(book_id, self.body())
                return status, {"id": book["id"], "title": book["title"]}
        if path.startswith(BOOKS + "/"):
            self.require_token(False)
            pieces = path[len(BOOKS) + 1:].split("/")
            if BOOK_ID.fullmatch(pieces[0]):
                book_id = pieces[0]
                if len(pieces) == 1:
                    if method == "GET":
                        return 200, self.get_book(book_id)
                    if method == "PUT":
                        return self.put_book(book_id, self.body())
                if pieces[1:] == ["progress"] and method == "PATCH":
                    return 200, self.update_progress(book_id, self.body())
        raise ApiError(404, "not_found")

    def dispatch(self):
        try:
            status, body = self.route()
        except ApiError as error:
            status, body = error.status, {"error": error.code}
        except sqlite3.Error:
            status, body = 503, {"error": "storage_unavailable"}
        try:
            self.reply(status, body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    do_GET = do_POST = do_PUT = do_PATCH = do_OPTIONS = dispatch


def main():
    parser = argparse.ArgumentParser(description="Private bookshelf sync API")
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8794)
    args = parser.parse_args()
    os.umask(0o077)
    args.db.parent.mkdir(parents=True, exist_ok=True)
    origins = tuple(origin.strip() for origin in os.getenv(
        "PAPERFOLD_ALLOWED_ORIGINS", ",".join(DEFAULT_ORIGINS)).split(",") if origin.strip())
    with SyncServer((args.host, args.port), args.db, os.getenv("PAPERFOLD_SYNC_TOKEN", ""),
                    os.getenv("PAPERFOLD_INGEST_TOKEN", ""), origins) as server:
        print("Paperfold sync is listening on", server.server_address, flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
