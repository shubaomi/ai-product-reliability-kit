from __future__ import annotations

import json
import random
import threading
import time
import traceback
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Any, Callable
from urllib import request


Transport = Callable[[request.Request, float], dict[str, Any]]


class ReliabilityClient:
    def __init__(
        self,
        product_id: str,
        environment: str,
        release: str,
        endpoint: str = "http://127.0.0.1:8787",
        api_key: str | None = None,
        *,
        schema_version: str = "1.0",
        timeout_seconds: float = 2.0,
        max_retries: int = 3,
        base_delay_seconds: float = 0.1,
        max_delay_seconds: float = 5.0,
        jitter_ratio: float = 0.2,
        max_queue_size: int = 1000,
        close_timeout_seconds: float = 5.0,
        fail_open: bool = True,
        transport: Transport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        random_fn: Callable[[], float] = random.random,
        id_factory: Callable[[], str] = lambda: str(uuid.uuid4()),
    ) -> None:
        if not product_id:
            raise ValueError("product_id is required")
        if not environment:
            raise ValueError("environment is required")
        if not release:
            raise ValueError("release is required")
        if not _is_v1(schema_version):
            raise ValueError(f"Unsupported schema version: {schema_version}")
        if timeout_seconds <= 0 or close_timeout_seconds <= 0:
            raise ValueError("timeouts must be positive")
        if max_retries < 0 or max_queue_size <= 0:
            raise ValueError("max_retries must be non-negative and max_queue_size must be positive")
        if not 0 <= jitter_ratio <= 1:
            raise ValueError("jitter_ratio must be between 0 and 1")

        self.product_id = product_id
        self.environment = environment
        self.release = release
        self.endpoint = endpoint.rstrip("/")
        self.api_key = api_key
        self.schema_version = schema_version
        self.timeout_seconds = timeout_seconds
        self.max_retries = max_retries
        self.base_delay_seconds = base_delay_seconds
        self.max_delay_seconds = max_delay_seconds
        self.jitter_ratio = jitter_ratio
        self.max_queue_size = max_queue_size
        self.close_timeout_seconds = close_timeout_seconds
        self.fail_open = fail_open
        self._transport = transport or _default_transport
        self._sleep = sleep
        self._random = random_fn
        self._id_factory = id_factory
        self._queue: list[dict[str, Any]] = []
        self._dropped = 0
        self._closed = False
        self._lock = threading.RLock()
        self._flush_condition = threading.Condition(self._lock)
        self._flush_active = False
        self._flush_generation = 0
        self._completed_flush_results: deque[tuple[int, dict[str, Any]]] = deque(maxlen=32)

    def event(self, name: str, properties: dict[str, Any] | None = None, **context: Any) -> dict[str, Any] | None:
        return self._enqueue("event", {"event": name, "properties": properties or {}}, context)

    def error(self, error: BaseException | str, include_stack: bool = False, **context: Any) -> dict[str, Any] | None:
        if isinstance(error, BaseException):
            payload = {
                "name": error.__class__.__name__,
                "message": str(error),
                "stack": "".join(traceback.format_exception(error)) if include_stack else None,
                "properties": context.pop("properties", {}),
            }
        else:
            payload = {"name": "Error", "message": str(error), "properties": context.pop("properties", {})}
        return self._enqueue("error", payload, context)

    def health(self, checks: dict[str, Any] | None = None, **context: Any) -> dict[str, Any] | None:
        return self._enqueue("health", health_payload(checks or {}), context)

    def release_event(self, version: str, properties: dict[str, Any] | None = None, **context: Any) -> dict[str, Any] | None:
        return self._enqueue("release", {"version": version, "properties": properties or {}}, context)

    def release_signal(self, version: str, properties: dict[str, Any] | None = None, **context: Any) -> dict[str, Any] | None:
        return self.release_event(version, properties, **context)

    def product(self, contract: dict[str, Any], **context: Any) -> dict[str, Any] | None:
        return self._enqueue("product", {"contract": contract}, context)

    def queued(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._queue)

    def dropped(self) -> int:
        with self._lock:
            return self._dropped

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {"queued": len(self._queue), "dropped": self._dropped, "closed": self._closed}

    def flush(self, *, deadline: float | None = None) -> dict[str, Any]:
        with self._flush_condition:
            while self._flush_active:
                if deadline is None:
                    self._flush_condition.wait()
                else:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return _deadline_result()
                    self._flush_condition.wait(timeout=remaining)
            if not self._queue:
                return {"sent": 0, "failed": 0, "attempts": 0}
            batch = self._queue[:]
            self._queue.clear()
            self._flush_active = True

        result: dict[str, Any] | None = None
        try:
            result = self._flush_batch(batch, deadline)
            return result
        except BaseException as error:
            result = getattr(error, "result", _failed_result(batch, error))
            raise
        finally:
            self._complete_flush(result)

    def _flush_batch(self, batch: list[dict[str, Any]], deadline: float | None) -> dict[str, Any]:

        data = json.dumps({"items": batch}, separators=(",", ":")).encode("utf-8")
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        req = request.Request(f"{self.endpoint}/api/ingest", data=data, headers=headers, method="POST")
        last_error: Exception | None = None
        timed_out = False
        attempts = 0

        for attempt in range(self.max_retries + 1):
            remaining = float("inf") if deadline is None else deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                last_error = TimeoutError("Reliability close deadline exceeded")
                break
            attempts += 1
            retryable = True
            try:
                payload = self._transport(req, min(self.timeout_seconds, remaining))
                return {"sent": len(batch), "failed": 0, "attempts": attempts, **payload}
            except Exception as error:  # transport errors must not escape in fail-open mode
                last_error = error
                timed_out = timed_out or isinstance(error, TimeoutError)
                retryable = _is_retryable_error(error)

            if not retryable:
                break
            if attempt < self.max_retries:
                delay = self._retry_delay(attempt)
                if deadline is not None and time.monotonic() + delay >= deadline:
                    timed_out = True
                    break
                self._sleep(delay)

        self._requeue(batch)
        result = {
            "sent": 0,
            "failed": len(batch),
            "attempts": attempts,
            "timed_out": timed_out,
            "error": str(last_error or "Reliability ingest failed"),
        }
        if self.fail_open:
            return result
        assert last_error is not None
        last_error.result = result
        raise last_error

    def close(self, timeout_seconds: float | None = None) -> dict[str, Any]:
        with self._flush_condition:
            self._closed = True
            start_generation = self._flush_generation
        timeout = self.close_timeout_seconds if timeout_seconds is None else timeout_seconds
        if timeout <= 0:
            raise ValueError("close timeout must be positive")
        deadline = time.monotonic() + timeout
        fallback = {"sent": 0, "failed": 0, "attempts": 0}
        while True:
            fallback = self.flush(deadline=deadline)
            if fallback.get("failed", 0) or fallback.get("timed_out"):
                break
            with self._flush_condition:
                if not self._flush_active and not self._queue:
                    break
            if time.monotonic() >= deadline:
                fallback = _deadline_result()
                break
        return self._close_result_since(start_generation, fallback)

    def __enter__(self) -> ReliabilityClient:
        return self

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        self.close()

    def _enqueue(self, item_type: str, payload: dict[str, Any], context: dict[str, Any]) -> dict[str, Any] | None:
        with self._lock:
            if self._closed:
                self._dropped += 1
                return None
            item = {
                "schema_version": self.schema_version,
                "type": item_type,
                "product_id": self.product_id,
                "environment": self.environment,
                "release": self.release,
                "occurred_at": context.pop("occurred_at", _now()),
                "anonymous_id": context.pop("anonymous_id", None),
                "user_id": context.pop("user_id", None),
                "request_id": context.pop("request_id", None),
                "idempotency_key": context.pop("idempotency_key", self._id_factory()),
                "payload": payload,
            }
            if len(self._queue) >= self.max_queue_size:
                self._queue.pop(0)
                self._dropped += 1
            self._queue.append(item)
        return item

    def _requeue(self, batch: list[dict[str, Any]]) -> None:
        with self._lock:
            combined = batch + self._queue
            if len(combined) > self.max_queue_size:
                self._dropped += len(combined) - self.max_queue_size
                combined = combined[: self.max_queue_size]
            self._queue = combined

    def _complete_flush(self, result: dict[str, Any] | None) -> None:
        completed = result or {"sent": 0, "failed": 0, "attempts": 0, "error": "Reliability ingest failed"}
        with self._flush_condition:
            self._flush_active = False
            self._flush_generation += 1
            self._completed_flush_results.append((self._flush_generation, completed))
            self._flush_condition.notify_all()

    def _close_result_since(self, start_generation: int, fallback: dict[str, Any]) -> dict[str, Any]:
        with self._flush_condition:
            completed = [result for generation, result in self._completed_flush_results if generation > start_generation]
        return _merge_flush_results(completed) if completed else fallback

    def _retry_delay(self, attempt: int) -> float:
        exponential = min(self.max_delay_seconds, self.base_delay_seconds * (2**attempt))
        jitter = 1 + (((self._random() * 2) - 1) * self.jitter_ratio)
        return max(0.0, exponential * jitter)


def health_payload(checks: dict[str, Any]) -> dict[str, Any]:
    normalized = {name: bool(value) for name, value in checks.items()}
    return {"ok": all(normalized.values()), "checks": normalized}


def _deadline_result() -> dict[str, Any]:
    return {
        "sent": 0,
        "failed": 0,
        "attempts": 0,
        "timed_out": True,
        "error": "Reliability close deadline exceeded",
    }


def _failed_result(batch: list[dict[str, Any]], error: BaseException) -> dict[str, Any]:
    return {
        "sent": 0,
        "failed": len(batch),
        "attempts": 0,
        "error": str(error) or "Reliability ingest failed",
    }


def _merge_flush_results(results: list[dict[str, Any]]) -> dict[str, Any]:
    merged = {
        "sent": sum(int(result.get("sent", 0)) for result in results),
        "failed": sum(int(result.get("failed", 0)) for result in results),
        "attempts": sum(int(result.get("attempts", 0)) for result in results),
    }
    if any("accepted" in result for result in results):
        merged["accepted"] = sum(int(result.get("accepted", 0)) for result in results)
    if any(result.get("timed_out") for result in results):
        merged["timed_out"] = True
    error = next((result.get("error") for result in results if result.get("error")), None)
    if error:
        merged["error"] = error
    return merged


def _default_transport(req: request.Request, timeout: float) -> dict[str, Any]:
    with request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def _is_v1(value: str) -> bool:
    parts = value.split(".")
    return len(parts) == 2 and parts[0] == "1" and all(part.isdigit() for part in parts)


def _is_retryable_error(error: Exception) -> bool:
    status = None
    for attribute in ("status", "status_code", "code"):
        value = getattr(error, attribute, None)
        if isinstance(value, int) and not isinstance(value, bool):
            status = value
            break
    if status is None:
        return True
    return status in (408, 425, 429) or 500 <= status < 600


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
