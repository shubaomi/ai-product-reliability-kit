import json
import pathlib
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from ai_product_reliability import ReliabilityClient, health_payload


FIXTURE_DIR = pathlib.Path(__file__).resolve().parents[3] / "standard" / "test" / "fixtures" / "protocol"


class IngestHandler(BaseHTTPRequestHandler):
    received = []

    def do_POST(self):
        length = int(self.headers["content-length"])
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        self.received.append({"payload": payload, "authorization": self.headers.get("authorization")})
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"accepted": len(payload["items"])}).encode("utf-8"))

    def log_message(self, *_args):
        return


class ReliabilityClientTest(unittest.TestCase):
    def test_client_flushes_batch_to_real_http_collector(self):
        IngestHandler.received = []
        server = HTTPServer(("127.0.0.1", 0), IngestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = ReliabilityClient(
                product_id="sdk-python-test",
                environment="production",
                release="test-sha",
                endpoint=f"http://127.0.0.1:{server.server_port}",
                api_key="python-sdk-key",
            )
            client.event("user_signed_up", {"plan": "free"}, anonymous_id="anon-1")
            client.error(ValueError("boom"), request_id="req-1")
            client.health({"database": True, "ai_api": True})
            result = client.flush()
            self.assertEqual(result["accepted"], 3)
            self.assertEqual(len(client.queued()), 0)
            self.assertEqual(IngestHandler.received[-1]["authorization"], "Bearer python-sdk-key")
            self.assertRegex(IngestHandler.received[-1]["payload"]["items"][0]["idempotency_key"], r"^[0-9a-f-]{36}$")
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()

    def test_retry_keeps_idempotency_and_final_failure_is_fail_open_and_requeued(self):
        attempts = []

        def eventually_succeeds(req, timeout):
            attempts.append((req.data, timeout))
            if len(attempts) == 1:
                raise URLError("offline")
            return {"accepted": 1}

        client = ReliabilityClient(
            "sdk-python-retry",
            "production",
            "test-sha",
            max_retries=1,
            base_delay_seconds=0,
            jitter_ratio=0,
            transport=eventually_succeeds,
        )
        client.event("retried_event")
        self.assertEqual(client.flush()["accepted"], 1)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0][0], attempts[1][0])

        offline = ReliabilityClient(
            "sdk-python-offline",
            "production",
            "test-sha",
            max_retries=1,
            base_delay_seconds=0,
            transport=lambda _req, _timeout: (_ for _ in ()).throw(URLError("offline")),
        )
        offline.event("preserved_event")
        result = offline.flush()
        self.assertEqual(result["failed"], 1)
        self.assertEqual(len(offline.queued()), 1)

    def test_retry_classifies_permanent_and_transient_http_statuses(self):
        for status in (400, 401, 403):
            with self.subTest(status=status, retryable=False):
                attempts = []

                def permanent_failure(_req, _timeout):
                    attempts.append(status)
                    raise HTTPError("https://collector.test/api/ingest", status, "permanent", {}, None)

                client = ReliabilityClient(
                    f"sdk-python-permanent-{status}",
                    "production",
                    "test-sha",
                    max_retries=2,
                    base_delay_seconds=0,
                    jitter_ratio=0,
                    transport=permanent_failure,
                )
                client.event("permanent_failure")

                result = client.flush()

                self.assertEqual(result["failed"], 1)
                self.assertEqual(result["attempts"], 1)
                self.assertEqual(len(attempts), 1)
                self.assertEqual(len(client.queued()), 1)

        for status in (408, 425, 429, 500, 503):
            with self.subTest(status=status, retryable=True):
                attempts = []

                def transient_then_success(_req, _timeout):
                    attempts.append(status)
                    if len(attempts) == 1:
                        raise HTTPError("https://collector.test/api/ingest", status, "transient", {}, None)
                    return {"accepted": 1}

                client = ReliabilityClient(
                    f"sdk-python-transient-{status}",
                    "production",
                    "test-sha",
                    max_retries=1,
                    base_delay_seconds=0,
                    jitter_ratio=0,
                    transport=transient_then_success,
                )
                client.event("transient_failure")

                result = client.flush()

                self.assertEqual(result["accepted"], 1)
                self.assertEqual(result["attempts"], 2)
                self.assertEqual(len(attempts), 2)
                self.assertEqual(len(client.queued()), 0)

    def test_bounded_queue_drop_count_timeout_and_close(self):
        ids = iter(["id-1", "id-2", "id-3"])
        client = ReliabilityClient(
            "sdk-python-bounded",
            "production",
            "test-sha",
            max_queue_size=2,
            id_factory=lambda: next(ids),
            transport=lambda req, _timeout: {"accepted": len(json.loads(req.data)["items"])},
        )
        client.event("first")
        client.event("second")
        client.event("third")
        self.assertEqual([item["payload"]["event"] for item in client.queued()], ["second", "third"])
        self.assertEqual(client.dropped(), 1)
        self.assertEqual(client.close()["accepted"], 2)
        self.assertIsNone(client.event("after_close"))
        self.assertEqual(client.dropped(), 2)

        observed_timeout = []

        def timeout_transport(_req, timeout):
            observed_timeout.append(timeout)
            raise TimeoutError("timed out")

        timing_out = ReliabilityClient(
            "sdk-python-timeout",
            "production",
            "test-sha",
            timeout_seconds=0.02,
            max_retries=0,
            transport=timeout_transport,
        )
        timing_out.event("timeout_event")
        result = timing_out.flush()
        self.assertEqual(result["failed"], 1)
        self.assertTrue(result["timed_out"])
        self.assertEqual(observed_timeout, [0.02])

    def test_close_joins_in_flight_flush_and_drains_race_enqueue(self):
        first_started = threading.Event()
        release_first = threading.Event()
        close_done = threading.Event()
        state_lock = threading.Lock()
        active = 0
        max_active = 0
        requests = []

        def transport(req, _timeout):
            nonlocal active, max_active
            body = json.loads(req.data)
            with state_lock:
                active += 1
                max_active = max(max_active, active)
                requests.append([item["payload"]["event"] for item in body["items"]])
                call_number = len(requests)
            if call_number == 1:
                first_started.set()
                release_first.wait(timeout=2)
            with state_lock:
                active -= 1
            return {"accepted": len(body["items"])}

        client = ReliabilityClient(
            "sdk-python-close-race",
            "production",
            "test-sha",
            close_timeout_seconds=1,
            transport=transport,
        )
        client.event("first")
        flush_results = []
        flush_errors = []
        flush_thread = threading.Thread(
            target=lambda: _capture_call(client.flush, flush_results, flush_errors),
            daemon=True,
        )
        flush_thread.start()
        self.assertTrue(first_started.wait(timeout=1))
        client.event("second")
        close_results = []
        close_errors = []

        def close_client():
            _capture_call(client.close, close_results, close_errors)
            close_done.set()

        close_thread = threading.Thread(target=close_client, daemon=True)
        close_thread.start()
        closed_before_release = close_done.wait(timeout=0.05)
        with state_lock:
            requests_before_release = len(requests)
        release_first.set()
        flush_thread.join(timeout=2)
        close_thread.join(timeout=2)

        self.assertFalse(closed_before_release)
        self.assertEqual(requests_before_release, 1)
        self.assertFalse(flush_thread.is_alive())
        self.assertFalse(close_thread.is_alive())
        self.assertEqual(flush_errors, [])
        self.assertEqual(close_errors, [])
        self.assertEqual(requests, [["first"], ["second"]])
        self.assertEqual(max_active, 1)
        self.assertEqual(close_results[0]["accepted"], 2)
        self.assertEqual(len(client.queued()), 0)

    def test_close_deadline_bounds_joining_an_in_flight_flush(self):
        request_started = threading.Event()
        release_request = threading.Event()

        def transport(req, _timeout):
            request_started.set()
            release_request.wait(timeout=2)
            return {"accepted": len(json.loads(req.data)["items"])}

        client = ReliabilityClient(
            "sdk-python-close-deadline",
            "production",
            "test-sha",
            close_timeout_seconds=0.02,
            transport=transport,
        )
        client.event("slow_event")
        flush_results = []
        flush_errors = []
        flush_thread = threading.Thread(
            target=lambda: _capture_call(client.flush, flush_results, flush_errors),
            daemon=True,
        )
        flush_thread.start()
        self.assertTrue(request_started.wait(timeout=1))

        started_at = time.monotonic()
        result = client.close()
        elapsed = time.monotonic() - started_at
        release_request.set()
        flush_thread.join(timeout=2)

        self.assertTrue(result["timed_out"])
        self.assertLess(elapsed, 0.2)
        self.assertFalse(flush_thread.is_alive())
        self.assertEqual(flush_errors, [])
        self.assertEqual(flush_results[0]["accepted"], 1)
        self.assertEqual(len(client.queued()), 0)

    def test_shared_versioned_contract_cases(self):
        cases = json.loads((FIXTURE_DIR / "contract-cases.json").read_text(encoding="utf-8"))
        for schema_version in cases["supported_versions"]:
            client = ReliabilityClient(
                "fixture-product",
                "production",
                "git:fixture",
                schema_version=schema_version,
                id_factory=lambda: "fixture-id",
            )
            item = client.event("fixture_completed")
            for field in cases["required_fields"]:
                self.assertIn(field, item, f"{schema_version} missing {field}")
            self.assertEqual(item["schema_version"], schema_version)

    def test_health_payload(self):
        self.assertEqual(
            health_payload({"database": True, "cache": False}),
            {"ok": False, "checks": {"database": True, "cache": False}},
        )


def _capture_call(call, results, errors):
    try:
        results.append(call())
    except BaseException as error:
        errors.append(error)


if __name__ == "__main__":
    unittest.main()
