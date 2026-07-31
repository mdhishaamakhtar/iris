"""Structured JSON logging for both the web process and Celery workers."""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime
from logging.handlers import RotatingFileHandler
from typing import TYPE_CHECKING

from flask import g, has_request_context, request

if TYPE_CHECKING:
    from flask import Flask

    from app.config import Settings

# Attributes the stdlib puts on every record. Anything else on a record came
# from a caller's `extra=` and is merged into the JSON payload verbatim.
_STANDARD_ATTRS = frozenset(
    logging.LogRecord("", 0, "", 0, "", None, None).__dict__
) | frozenset({"asctime", "message", "taskName"})

_REQUEST_ATTRS = ("request_id", "http_method", "http_path", "remote_addr")


class JSONFormatter(logging.Formatter):
    """Renders each record as one line of JSON."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        payload |= {name: getattr(record, name, "") for name in _REQUEST_ATTRS}

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        payload |= {
            key: value
            for key, value in record.__dict__.items()
            if key not in _STANDARD_ATTRS
            and key not in _REQUEST_ATTRS
            and not key.startswith("_")
        }
        return json.dumps(payload, default=str)


class RequestContextFilter(logging.Filter):
    """Adds Flask request fields to records, blank when outside a request."""

    def filter(self, record: logging.LogRecord) -> bool:
        if has_request_context():
            record.request_id = getattr(g, "request_id", "")
            record.http_method = request.method
            record.http_path = request.path
            record.remote_addr = request.remote_addr or ""
        else:
            for name in _REQUEST_ATTRS:
                setattr(record, name, "")
        return True


def json_handler(handler: logging.Handler, level: int) -> logging.Handler:
    """Attach the JSON formatter and request-context filter to a handler."""
    handler.setFormatter(JSONFormatter())
    handler.addFilter(RequestContextFilter())
    handler.setLevel(level)
    return handler


def configure_logging(app: Flask, settings: Settings) -> None:
    level = getattr(logging, settings.log_level.upper(), logging.INFO)

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(json_handler(logging.StreamHandler(), level))
    root.setLevel(level)

    # Flask installs its own plain-text handler in debug mode; drop it so logs
    # aren't printed twice in two different formats.
    app.logger.handlers.clear()
    app.logger.setLevel(level)

    if not settings.debug and not settings.testing:
        os.makedirs(settings.log_dir, exist_ok=True)
        root.addHandler(
            json_handler(
                RotatingFileHandler(
                    os.path.join(settings.log_dir, "iris.log"),
                    maxBytes=10 * 1024 * 1024,
                    backupCount=10,
                ),
                logging.INFO,
            )
        )

    for noisy in ("urllib3", "requests"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
