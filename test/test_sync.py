from contextlib import contextmanager
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from server.paperfold_sync import BOOKS, PAIR, PAIR_FAILURES, PAIR_WINDOW_MS, ROOT, SyncServer, milliseconds


DEVICE = "test-device-" + "a" * 32
IMPORT = "test-import-" + "b" * 32
WEB = "https://liangzai4322.github.io"
ANDROID = "https://appassets.androidplatform.net"


@contextmanager
def running_server(path, pair_pin=None):
    with SyncServer(("127.0.0.1", 0), path, DEVICE, IMPORT, pair_pin=pair_pin) as service:
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


if __name__ == "__main__":
    unittest.main()
