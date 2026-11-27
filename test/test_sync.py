from contextlib import contextmanager
import json
import sqlite3
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from server.paperfold_sync import (
    ARCHIVE_AFTER_MS, BOOKS, PAIR, PAIR_FAILURES, PAIR_WINDOW_MS, PUBLIC_BOOKS, ROOT, SyncServer, milliseconds,
)


DEVICE = "test-device-" + "a" * 32
IMPORT = "test-import-" + "b" * 32
WEB = "https://liangzai4322.github.io"
ANDROID = "https://appassets.androidplatform.net"


@contextmanager
def running_server(path, pair_pin=None, public_shelf=False):
    with SyncServer(("127.0.0.1", 0), path, DEVICE, IMPORT,
                    pair_pin=pair_pin, public_shelf=public_shelf) as service:
        worker = Thread(target=service.serve_forever, daemon=True)
        worker.start()
        try:
            yield "http://127.0.0.1:" + str(service.server_port)
        finally:
            service.shutdown()
            worker.join()


def request(base, route=BOOKS, method="GET", token=DEVICE, data=None, **headers):
    request_headers = {}
    if token:
        request_headers["Authorization"] = "Bearer " + token
    if data is not None:
        request_headers["Content-Type"] = "application/json"
        data = json.dumps(data).encode()
    query = Request(base + route, data, {**request_headers, **headers}, method=method)
    try:
        response = urlopen(query, timeout=3)
    except HTTPError as error:
        response = error
    with response:
        body = response.read()
        return response.status, json.loads(body) if body else None, response.headers


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "books.sqlite3"

    def test_import_key_is_write_only_and_retries_do_not_duplicate(self):
        with running_server(self.path) as base:
            article = {"text": "# 题目\n\n**你好。**", "format": "markdown"}
            headers = {"Idempotency-Key": "note-0001"}
            code, book, _ = request(base, method="POST", token=IMPORT, data=article, **headers)
            self.assertEqual(code, 201)
            self.assertEqual(book["title"], "题目")
            self.assertEqual(set(book), {"id", "title"})
            duplicate = request(base, method="POST", token=IMPORT, data=article, **headers)
            self.assertEqual(duplicate[:2], (200, book))
            changed = request(base, method="POST", token=IMPORT, data={"text": "Other"}, **headers)
            self.assertEqual(changed[0], 409)
            self.assertEqual(request(base, token=IMPORT)[0], 403)
            path = BOOKS + "/" + book["id"]
            self.assertEqual(request(base, path, token=IMPORT)[0], 403)
            self.assertEqual(request(base, path + "/progress", "PATCH", IMPORT, {"offset": 12, "progressAt": 4})[0], 403)
            self.assertEqual(request(base, token="wrong")[0], 401)
            self.assertEqual(request(base, path + "/progress", "PATCH", DEVICE, {"offset": 12, "progressAt": 4})[0], 200)
            self.assertEqual(request(base, method="POST", token=IMPORT, data=article, **headers)[:2], (200, book))
        with running_server(self.path) as base:
            catalog = request(base, Origin=WEB)[1]["books"]
            self.assertEqual(len(catalog), 1)
            self.assertEqual((catalog[0]["id"], catalog[0]["offset"]), (book["id"], 12))
            self.assertNotIn("text", catalog[0])
            self.assertEqual(request(base, path, Origin=ANDROID)[1]["text"], article["text"])

    def test_two_devices_share_progress_without_overwriting_newer_changes(self):
        with running_server(self.path) as base:
            path = BOOKS + "/web-book-0001"
            self.assertEqual(request(base, path, "PUT", data={
                "title": "窗口", "text": "A" * 300, "format": "plain", "createdAt": 1000,
            }, Origin=WEB)[0], 201)
            self.assertEqual(request(base, path + "/progress", "PATCH", data={
                "offset": 140, "progressAt": 2000,
            }, Origin=WEB)[1]["offset"], 140)
            self.assertEqual(request(base, path, Origin=ANDROID)[1]["offset"], 140)
            self.assertEqual(request(base, path + "/progress", "PATCH", data={
                "offset": 60, "progressAt": 3000,
            }, Origin=ANDROID)[1]["offset"], 60)
            self.assertEqual(request(base, path + "/progress", "PATCH", data={
                "offset": 290, "progressAt": 2999,
            }, Origin=WEB)[1]["offset"], 60)
            self.assertEqual(request(base, Origin=WEB)[1]["books"][0]["offset"], 60)

    def test_cors_preflight_and_invalid_payload(self):
        with running_server(self.path) as base:
            code, _, headers = request(base, method="OPTIONS", token=None, Origin=ANDROID)
            self.assertEqual(code, 204)
            self.assertEqual(headers["Access-Control-Allow-Origin"], ANDROID)
            self.assertEqual(request(base, Origin="https://elsewhere.example")[0], 403)
            self.assertEqual(request(base, ROOT + "/healthz", token=None)[1], {"ok": True})
            self.assertEqual(request(base, method="POST", token=IMPORT, data={"text": " "})[0], 400)

    def test_omitting_format_keeps_new_imports_plain_and_retries_older_entries(self):
        with running_server(self.path) as base:
            latest = {"text": "# Raw Markdown syntax\n\n**Content**"}
            created = request(base, method="POST", token=IMPORT, data=latest)
            added = request(base, BOOKS + "/" + created[1]["id"])[1]
            self.assertEqual((added["format"], added["text"]), ("plain", latest["text"]))
            idem = {"Idempotency-Key": "older-markdown-book"}
            legacy = request(base, method="POST", token=IMPORT, data={**latest, "format": "auto"}, **idem)
            repeated = request(base, method="POST", token=IMPORT, data=latest, **idem)
            self.assertEqual(repeated[:2], (200, legacy[1]))
            self.assertEqual(request(base, BOOKS + "/" + legacy[1]["id"])[1]["format"], "auto")

    def test_pairing_exchanges_the_code_for_a_device_token_and_is_rate_limited(self):
        pin = "937162"
        with running_server(self.path, pair_pin=pin) as base:
            preflight = request(base, PAIR, "OPTIONS", None, Origin=ANDROID)
            self.assertEqual(preflight[0], 204)
            self.assertEqual(preflight[2]["Access-Control-Allow-Origin"], ANDROID)
            result = request(base, PAIR, "POST", None, {"pin": pin}, Origin=WEB)
            self.assertEqual(result[:2], (200, {"token": DEVICE}))
            self.assertEqual(result[2]["Cache-Control"], "no-store")
            self.assertEqual(request(base, token=pin)[0], 401)
            for _ in range(PAIR_FAILURES):
                self.assertEqual(request(base, PAIR, "POST", None, {"pin": "000000"})[0], 401)
        with running_server(self.path, pair_pin=pin) as base:
            self.assertEqual(request(base, PAIR, "POST", None, {"pin": pin})[0], 429)
            self.assertEqual(request(base, token=DEVICE)[0], 200)
            self.assertEqual(request(base, token=IMPORT)[0], 403)
            with patch("server.paperfold_sync.milliseconds", return_value=milliseconds() + PAIR_WINDOW_MS + 1):
                self.assertEqual(request(base, PAIR, "POST", None, {"pin": pin})[0], 200)


    def test_public_shelf_needs_explicit_publication_after_migration(self):
        with sqlite3.connect(self.path) as db:
            db.execute("""CREATE TABLE books (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, format TEXT NOT NULL,
                bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, pos_offset INTEGER NOT NULL DEFAULT 0,
                progress_at INTEGER NOT NULL DEFAULT 0
            )""")
            db.execute("INSERT INTO books VALUES ('older-private', 'Old', 'private', 'plain', 7, 1, 2, 3)")
        with running_server(self.path) as base:
            self.assertEqual(request(base, PUBLIC_BOOKS, token=None)[0], 404)
        with running_server(self.path, public_shelf=True) as base:
            self.assertEqual(request(base, PUBLIC_BOOKS, token=None)[1]["books"], [])
            self.assertEqual(request(base, PUBLIC_BOOKS + "/older-private", token=None)[0], 404)
            self.assertEqual(request(base, BOOKS + "/older-private")[1]["offset"], 2)
            action = BOOKS + "/older-private/shelf"
            self.assertEqual(request(base, action, "PATCH", None, {"action": "publish"})[0], 401)
            self.assertEqual(request(base, action, "PATCH", IMPORT, {"action": "publish"})[0], 403)
            self.assertEqual(request(base, action, "PATCH", DEVICE, {"action": "publish"})[0], 200)
            code, body, _ = request(base, PUBLIC_BOOKS + "/older-private", token=None, Origin=WEB)
            self.assertEqual((code, body["text"]), (200, "private"))
            self.assertNotIn("offset", body)
            self.assertNotIn("progressAt", body)

    def test_public_shelf_activity_and_archive_keep_the_book_readable(self):
        upload_time = milliseconds()
        clock = "server.paperfold_sync.milliseconds"
        active = PUBLIC_BOOKS
        archived = PUBLIC_BOOKS + "?archived=1"
        with running_server(self.path, public_shelf=True) as base:
            body = {"text": "A book for the shelf"}
            self.assertEqual(request(base, method="POST", token=None, data=body)[0], 401)
            with patch(clock, return_value=upload_time):
                code, book, _ = request(base, method="POST", token=IMPORT, data=body)
            self.assertEqual(code, 201)
            public_book = PUBLIC_BOOKS + "/" + book["id"]
            action = BOOKS + "/" + book["id"] + "/shelf"
            with patch(clock, return_value=upload_time + ARCHIVE_AFTER_MS - 1):
                self.assertEqual(len(request(base, active, token=None)[1]["books"]), 1)
                self.assertEqual(request(base, public_book, token=None)[0], 200)
            with patch(clock, return_value=upload_time + ARCHIVE_AFTER_MS):
                self.assertEqual(request(base, active, token=None)[1]["books"], [])
                self.assertEqual(len(request(base, archived, token=None)[1]["books"]), 1)
                self.assertEqual(request(base, action, "PATCH", DEVICE, {"action": "read"})[1]["archived"], 1)
                self.assertEqual(request(base, action, "PATCH", DEVICE, {"action": "restore"})[1]["archived"], 0)
            with patch(clock, return_value=upload_time + 2 * ARCHIVE_AFTER_MS - 1):
                self.assertEqual(request(base, action, "PATCH", DEVICE, {"action": "read"})[1]["archived"], 0)
            with patch(clock, return_value=upload_time + 2 * ARCHIVE_AFTER_MS):
                self.assertEqual(len(request(base, active, token=None)[1]["books"]), 1)
                self.assertEqual(request(base, action, "PATCH", DEVICE, {"action": "archive"})[1]["archived"], 1)
                self.assertEqual(request(base, public_book, token=None)[1]["text"], body["text"])
                self.assertEqual(request(base, active, token=None)[1]["books"], [])


if __name__ == "__main__":
    unittest.main()
