"""HTTP API.

Errors are raised, not returned: the app-level handlers in ``app/__init__.py``
render every one of them into the same JSON shape, so handlers here only
describe the success path.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from celery import states
from flask import (
    Blueprint,
    Response,
    current_app,
    jsonify,
    redirect,
    request,
    url_for,
)
from marshmallow import Schema, ValidationError, fields, validate, validates_schema

from app import celery, services
from app.errors import ConflictError, ErrorCode, InvalidRequestError, NotFoundError
from app.pathfinding import ALGORITHMS, BIDIRECTIONAL
from app.tasks import find_path_task

logger = logging.getLogger(__name__)

api = Blueprint("api", __name__)

PROGRESS = "PROGRESS"

# Prefixes a client may clear. Anything else would let this endpoint wipe the
# Celery result backend, which shares the same Redis database.
CLEARABLE_PREFIXES = ("bfs:", "wiki_links:", "wiki_backlinks:", "path:", "page_info:")


class SearchSchema(Schema):
    """Validates POST /getPath."""

    start = fields.Str(required=True, validate=validate.Length(min=1, max=255))
    end = fields.Str(required=True, validate=validate.Length(min=1, max=255))
    algorithm = fields.Str(
        load_default=BIDIRECTIONAL, validate=validate.OneOf(ALGORITHMS)
    )

    @validates_schema
    def check_pages_differ(self, data: dict, **_: object) -> None:
        if data.get("start", "").strip() == data.get("end", "").strip():
            raise ValidationError("Start and end pages must be different", "end")


@api.post("/getPath")
def start_search() -> tuple[Response, int]:
    """Queue a background search between two Wikipedia pages.
    ---
    tags: [Pathfinding]
    summary: Start pathfinding
    parameters:
      - in: body
        name: body
        required: true
        schema:
          type: object
          required: [start, end]
          properties:
            start:
              type: string
              example: "Python (programming language)"
              description: Wikipedia page title to start from
            end:
              type: string
              example: "Monty Python"
              description: Wikipedia page title to reach
            algorithm:
              type: string
              enum: [bidirectional, bfs]
              default: bidirectional
              description: >
                "bidirectional" searches from both ends at once using backlinks
                for the reverse frontier, and is usually far faster. "bfs"
                walks forward only.
    responses:
      202:
        description: Search accepted; poll poll_url for progress and the result
      400:
        description: Validation error
    """
    data = SearchSchema().load(request.get_json(silent=True) or {})
    start, end = data["start"].strip(), data["end"].strip()

    task = find_path_task.delay(start, end, data["algorithm"])
    logger.info(
        "search_queued",
        extra={"task_id": task.id, "start_page": start, "end_page": end},
    )

    return jsonify(
        {
            "status": "IN_PROGRESS",
            "task_id": task.id,
            "poll_url": url_for("api.search_status", task_id=task.id),
            "start_page": start,
            "end_page": end,
        }
    ), 202


@api.get("/tasks/status/<task_id>")
def search_status(task_id: str) -> Response:
    """Poll a search for progress or its result.
    ---
    tags: [Pathfinding]
    summary: Get task status
    parameters:
      - name: task_id
        in: path
        required: true
        type: string
    responses:
      200:
        description: Current status — PENDING, IN_PROGRESS, SUCCESS, FAILURE or REVOKED
      404:
        description: Malformed task ID
    """
    _require_task_id(task_id)
    task = find_path_task.AsyncResult(task_id)
    body: dict[str, object] = {"task_id": task_id}

    if task.state == states.PENDING:
        body |= {"status": states.PENDING, "message": "Task is waiting to be processed"}
    elif task.state == PROGRESS:
        body |= {"status": "IN_PROGRESS", "progress": task.info}
    elif task.state == states.SUCCESS:
        body |= {"status": states.SUCCESS, **_result(task.result)}
    elif task.state == states.FAILURE:
        body |= {"status": states.FAILURE, "error": str(task.info)}
    else:
        body |= {"status": task.state}

    return jsonify(body)


def _result(payload: Any) -> dict[str, Any]:
    """Unwrap a finished task.

    The task reports its own failures as a successful return value, so a
    Celery SUCCESS can still be a search that found nothing.
    """
    if not isinstance(payload, dict):
        return {"result": payload}
    if payload.get("status") == states.FAILURE:
        return {
            "status": states.FAILURE,
            "error": payload.get("error"),
            "code": payload.get("code"),
        }
    return {
        "result": {
            "path": payload.get("path", []),
            "length": payload.get("length", 0),
            "search_time": payload.get("search_time"),
            "nodes_explored": payload.get("nodes_explored"),
            "search_stats": payload.get("search_stats"),
        }
    }


@api.get("/tasks")
def list_tasks() -> Response:
    """List active, reserved and scheduled tasks across all workers.
    ---
    tags: [Tasks]
    summary: List tasks
    responses:
      200:
        description: Current task queues
    """
    inspect = celery.control.inspect(timeout=2.0)
    active = inspect.active() or {}
    reserved = inspect.reserved() or {}

    return jsonify(
        {
            "active": active,
            "reserved": reserved,
            "scheduled": inspect.scheduled() or {},
            "total_active": sum(len(tasks) for tasks in active.values()),
            "total_reserved": sum(len(tasks) for tasks in reserved.values()),
        }
    )


@api.delete("/tasks/<task_id>")
def cancel_task(task_id: str) -> Response:
    """Revoke a task, terminating it if it is already running.
    ---
    tags: [Tasks]
    summary: Cancel task
    parameters:
      - name: task_id
        in: path
        required: true
        type: string
      - name: terminate
        in: query
        type: boolean
        default: true
    responses:
      200:
        description: Task revoked
      409:
        description: Task already finished
    """
    _require_task_id(task_id)
    terminate = _wants_terminate()

    if find_path_task.AsyncResult(task_id).state in (states.SUCCESS, states.FAILURE):
        raise ConflictError("Task has already finished")

    celery.control.revoke(task_id, terminate=terminate, signal="SIGTERM")
    logger.info("task_revoked", extra={"task_id": task_id, "terminate": terminate})
    return jsonify({"revoked": True, "task_id": task_id, "terminated": terminate})


@api.delete("/tasks")
def cancel_all_tasks() -> Response:
    """Revoke every active and reserved task.
    ---
    tags: [Tasks]
    summary: Cancel all tasks
    parameters:
      - name: terminate
        in: query
        type: boolean
        default: true
    responses:
      200:
        description: All tasks revoked
    """
    terminate = _wants_terminate()
    inspect = celery.control.inspect(timeout=2.0)

    task_ids = [
        task["id"]
        for group in ((inspect.active() or {}), (inspect.reserved() or {}))
        for tasks in group.values()
        for task in tasks
    ]
    for task_id in task_ids:
        celery.control.revoke(task_id, terminate=terminate, signal="SIGTERM")

    logger.info("all_tasks_revoked", extra={"count": len(task_ids)})
    return jsonify(
        {"revoked_count": len(task_ids), "task_ids": task_ids, "terminated": terminate}
    )


@api.get("/health")
def health() -> tuple[Response, int]:
    """Report Redis and cache connectivity.
    ---
    tags: [System]
    summary: Health check
    responses:
      200:
        description: Healthy
      503:
        description: Degraded
    """
    store = services().store
    checks = {"redis": "healthy" if store.ping() else "unhealthy: ping failed"}

    try:
        store.set("health_check:web", "ok", ttl=60)
        checks["cache"] = (
            "healthy" if store.get("health_check:web") == "ok" else "unhealthy"
        )
    except Exception as exc:
        checks["cache"] = f"unhealthy: {exc}"

    healthy = all(value == "healthy" for value in checks.values())
    return jsonify({"status": "healthy" if healthy else "degraded", **checks}), (
        200 if healthy else 503
    )


@api.post("/cache/clear")
def clear_cache() -> Response:
    """Clear cache entries matching a key pattern.
    ---
    tags: [System]
    summary: Clear cache
    parameters:
      - in: body
        name: body
        schema:
          type: object
          properties:
            pattern:
              type: string
              default: "wiki_links:*"
              description: >
                Must start with one of bfs:, wiki_links:, wiki_backlinks:,
                path: or page_info:
    responses:
      200:
        description: Cache cleared
      400:
        description: Pattern prefix not allowed
    """
    pattern = (request.get_json(silent=True) or {}).get("pattern", "wiki_links:*")
    if not pattern.startswith(CLEARABLE_PREFIXES):
        raise InvalidRequestError(
            f"Pattern must start with one of: {', '.join(CLEARABLE_PREFIXES)}"
        )

    cleared = services().store.clear_pattern(pattern)
    return jsonify(
        {
            "success": True,
            "pattern": pattern,
            "message": f"Cleared {cleared} cache entries",
        }
    )


@api.get("/api")
def api_info() -> Response:
    """Return API metadata and the endpoint list.
    ---
    tags: [System]
    summary: API info
    responses:
      200:
        description: API information
    """
    return jsonify(
        {
            "name": "Iris Wikipedia Pathfinder API",
            "version": "2.0.0",
            "description": "Find paths between Wikipedia pages",
            "endpoints": {
                "POST /getPath": "Start pathfinding between two pages",
                "GET /tasks/status/<task_id>": "Check search status",
                "GET /tasks": "List active/reserved/scheduled tasks",
                "DELETE /tasks/<task_id>": "Cancel a search",
                "DELETE /tasks": "Cancel all searches",
                "GET /health": "Health check",
                "POST /cache/clear": "Clear cached entries",
                "GET /": "Path visualization UI",
            },
            "swagger_ui": "/api/docs",
        }
    )


# --- UI -------------------------------------------------------------------

API_PREFIXES = ("getPath", "tasks", "health", "cache", "api", "apispec")


@api.get("/")
def index() -> Response:
    """Serve the visualisation UI."""
    return current_app.send_static_file("index.html")


@api.get("/<path:path>")
def catch_all(path: str) -> Response:
    """Send unknown API paths to a 404 and everything else to the UI."""
    if path.startswith(API_PREFIXES):
        raise NotFoundError("Endpoint not found")
    return redirect(url_for("api.index"))  # type: ignore[return-value]


# --- Helpers --------------------------------------------------------------


def _require_task_id(task_id: str) -> None:
    try:
        uuid.UUID(task_id)
    except ValueError as exc:
        raise NotFoundError(
            "Invalid task ID format", ErrorCode.INVALID_TASK_ID
        ) from exc


def _wants_terminate() -> bool:
    return request.args.get("terminate", "true").lower() != "false"
