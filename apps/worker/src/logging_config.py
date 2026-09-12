import json
import logging
import os
import sys
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Dict, Optional

# Context variables for request/job tracing across threads/coroutines
job_id_ctx: ContextVar[str] = ContextVar("job_id", default="")
trace_id_ctx: ContextVar[str] = ContextVar("trace_id", default="")
worker_id_ctx: ContextVar[str] = ContextVar("worker_id", default="")

STANDARD_LOG_RECORD_ATTRS = {
    "name",
    "msg",
    "args",
    "levelname",
    "levelno",
    "pathname",
    "filename",
    "module",
    "exc_info",
    "exc_text",
    "stack_info",
    "lineno",
    "funcName",
    "created",
    "msecs",
    "relativeCreated",
    "thread",
    "threadName",
    "processName",
    "process",
    "message",
    "asctime",
}


class StructuredJsonFormatter(logging.Formatter):
    """
    Formats log records as single-line JSON objects with ISO timestamps,
    correlation IDs, worker IDs, and execution context.
    """

    def __init__(self, default_worker_id: str = ""):
        super().__init__()
        self.default_worker_id = default_worker_id

    def format(self, record: logging.LogRecord) -> str:
        record.message = record.getMessage()

        worker_id = (
            getattr(record, "worker_id", None)
            or self.default_worker_id
            or worker_id_ctx.get()
        )
        job_id = getattr(record, "job_id", None) or job_id_ctx.get() or ""
        trace_id = getattr(record, "trace_id", None) or trace_id_ctx.get() or ""

        log_data: Dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.message,
        }

        if worker_id:
            log_data["worker_id"] = worker_id
        if job_id:
            log_data["job_id"] = job_id
        if trace_id:
            log_data["trace_id"] = trace_id

        # Capture any custom extra fields attached to the log record
        extra_fields = {
            k: v
            for k, v in record.__dict__.items()
            if k not in STANDARD_LOG_RECORD_ATTRS
            and k not in ("worker_id", "job_id", "trace_id")
        }
        if extra_fields:
            log_data["extra"] = extra_fields

        if record.exc_info:
            log_data["exception"] = self.formatException(record.exc_info)

        return json.dumps(log_data)


def set_log_context(
    job_id: Optional[str] = None,
    trace_id: Optional[str] = None,
    worker_id: Optional[str] = None,
) -> None:
    if job_id is not None:
        job_id_ctx.set(job_id)
    if trace_id is not None:
        trace_id_ctx.set(trace_id)
    if worker_id is not None:
        worker_id_ctx.set(worker_id)


def clear_log_context(clear_worker: bool = False) -> None:
    job_id_ctx.set("")
    trace_id_ctx.set("")
    if clear_worker:
        worker_id_ctx.set("")


def configure_logging(
    level: int = logging.INFO,
    log_format: Optional[str] = None,
    worker_id: str = "",
) -> None:
    format_type = (log_format or os.environ.get("LOG_FORMAT", "json")).lower()

    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    # Remove existing handlers to avoid duplicates
    for handler in list(root_logger.handlers):
        root_logger.removeHandler(handler)

    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(level)

    if format_type == "json":
        handler.setFormatter(StructuredJsonFormatter(default_worker_id=worker_id))
    else:
        handler.setFormatter(
            logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s")
        )

    root_logger.addHandler(handler)
    if worker_id:
        worker_id_ctx.set(worker_id)
