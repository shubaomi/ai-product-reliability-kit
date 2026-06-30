from __future__ import annotations

import json
import traceback
from datetime import datetime, timezone
from typing import Any
from urllib import request


class ReliabilityClient:
    def __init__(
        self,
        product_id: str,
        environment: str,
        release: str,
        endpoint: str = "http://127.0.0.1:8787",
        api_key: str | None = None,
    ) -> None:
        if not product_id:
            raise ValueError("product_id is required")
        if not environment:
            raise ValueError("environment is required")
        if not release:
            raise ValueError("release is required")

        self.product_id = product_id
        self.environment = environment
        self.release = release
        self.endpoint = endpoint.rstrip("/")
        self.api_key = api_key
        self._queue: list[dict[str, Any]] = []

    def event(self, name: str, properties: dict[str, Any] | None = None, **context: Any) -> dict[str, Any]:
        return self._enqueue("event", {"event": name, "properties": properties or {}}, context)

    def error(self, error: BaseException | str, include_stack: bool = False, **context: Any) -> dict[str, Any]:
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

    def health(self, checks: dict[str, Any] | None = None, **context: Any) -> dict[str, Any]:
        return self._enqueue("health", health_payload(checks or {}), context)

    def release_event(self, version: str, properties: dict[str, Any] | None = None, **context: Any) -> dict[str, Any]:
        return self._enqueue("release", {"version": version, "properties": properties or {}}, context)

    def product(self, contract: dict[str, Any], **context: Any) -> dict[str, Any]:
        return self._enqueue("product", {"contract": contract}, context)

    def queued(self) -> list[dict[str, Any]]:
        return list(self._queue)

    def flush(self) -> dict[str, Any]:
        if not self._queue:
            return {"sent": 0}

        batch = self._queue[:]
        data = json.dumps({"items": batch}).encode("utf-8")
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"

        req = request.Request(f"{self.endpoint}/api/ingest", data=data, headers=headers, method="POST")
        with request.urlopen(req, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
        self._queue.clear()
        return payload

    def _enqueue(self, item_type: str, payload: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
        item = {
            "schema_version": "1.0",
            "type": item_type,
            "product_id": self.product_id,
            "environment": self.environment,
            "release": self.release,
            "occurred_at": context.pop("occurred_at", _now()),
            "anonymous_id": context.pop("anonymous_id", None),
            "user_id": context.pop("user_id", None),
            "request_id": context.pop("request_id", None),
            "payload": payload,
        }
        self._queue.append(item)
        return item


def health_payload(checks: dict[str, Any]) -> dict[str, Any]:
    normalized = {name: bool(value) for name, value in checks.items()}
    return {"ok": all(normalized.values()), "checks": normalized}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

