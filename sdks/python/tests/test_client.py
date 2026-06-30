import json
import pathlib
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from ai_product_reliability import ReliabilityClient, health_payload


class IngestHandler(BaseHTTPRequestHandler):
    received = []

    def do_POST(self):
        if self.path != "/api/ingest":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers["content-length"])
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        self.received.append(payload)
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"accepted": len(payload["items"])}).encode("utf-8"))

    def log_message(self, *_args):
        return


class ReliabilityClientTest(unittest.TestCase):
    def test_client_flushes_batch(self):
        server = HTTPServer(("127.0.0.1", 0), IngestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = ReliabilityClient(
                product_id="sdk-python-test",
                environment="test",
                release="test-sha",
                endpoint=f"http://127.0.0.1:{server.server_port}",
            )
            client.event("user_signed_up", {"plan": "free"}, anonymous_id="anon-1")
            client.error(ValueError("boom"), request_id="req-1")
            client.health({"database": True, "ai_api": True})

            self.assertEqual(len(client.queued()), 3)
            result = client.flush()
            self.assertEqual(result["accepted"], 3)
            self.assertEqual(len(client.queued()), 0)
            self.assertEqual(IngestHandler.received[-1]["items"][0]["schema_version"], "1.0")
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()

    def test_health_payload(self):
        self.assertEqual(
            health_payload({"database": True, "cache": False}),
            {"ok": False, "checks": {"database": True, "cache": False}},
        )


if __name__ == "__main__":
    unittest.main()
