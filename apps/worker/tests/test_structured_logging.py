import json
import logging
import io
import pytest
from src.logging_config import (
    StructuredJsonFormatter,
    set_log_context,
    clear_log_context,
    configure_logging,
)
from src.worker import Worker
from src.config import WorkerConfig


@pytest.fixture(autouse=True)
def reset_logging_context():
    clear_log_context(clear_worker=True)
    yield
    clear_log_context(clear_worker=True)


def test_structured_json_formatter_basic():
    formatter = StructuredJsonFormatter(default_worker_id="default-worker-1")
    record = logging.LogRecord(
        name="test_logger",
        level=logging.INFO,
        pathname=__file__,
        lineno=20,
        msg="Hello %s",
        args=("world",),
        exc_info=None,
    )

    formatted = formatter.format(record)
    data = json.loads(formatted)

    assert data["level"] == "INFO"
    assert data["logger"] == "test_logger"
    assert data["message"] == "Hello world"
    assert data["worker_id"] == "default-worker-1"
    assert "timestamp" in data


def test_structured_json_formatter_with_context():
    formatter = StructuredJsonFormatter()
    set_log_context(
        job_id="job-abc-123",
        trace_id="trace-xyz-789",
        worker_id="worker-node-42",
    )

    try:
        record = logging.LogRecord(
            name="worker",
            level=logging.WARNING,
            pathname=__file__,
            lineno=35,
            msg="Task running",
            args=(),
            exc_info=None,
        )
        data = json.loads(formatter.format(record))

        assert data["level"] == "WARNING"
        assert data["job_id"] == "job-abc-123"
        assert data["trace_id"] == "trace-xyz-789"
        assert data["worker_id"] == "worker-node-42"
    finally:
        clear_log_context()

    # After clear, job_id and trace_id should not appear
    record_after = logging.LogRecord(
        name="worker",
        level=logging.INFO,
        pathname=__file__,
        lineno=55,
        msg="Idle",
        args=(),
        exc_info=None,
    )
    data_after = json.loads(formatter.format(record_after))
    assert "job_id" not in data_after
    assert "trace_id" not in data_after


def test_structured_json_formatter_extra_fields():
    formatter = StructuredJsonFormatter()
    record = logging.LogRecord(
        name="worker",
        level=logging.ERROR,
        pathname=__file__,
        lineno=70,
        msg="Failed to connect",
        args=(),
        exc_info=None,
    )
    record.retry_count = 3
    record.target_host = "redis:6379"

    data = json.loads(formatter.format(record))
    assert data["extra"]["retry_count"] == 3
    assert data["extra"]["target_host"] == "redis:6379"


def test_structured_json_formatter_exception():
    formatter = StructuredJsonFormatter()
    try:
        raise ValueError("simulated execution failure")
    except ValueError:
        import sys
        exc_info = sys.exc_info()

    record = logging.LogRecord(
        name="worker",
        level=logging.ERROR,
        pathname=__file__,
        lineno=95,
        msg="Execution error occurred",
        args=(),
        exc_info=exc_info,
    )

    data = json.loads(formatter.format(record))
    assert "exception" in data
    assert "ValueError: simulated execution failure" in data["exception"]


def test_configure_logging_integration():
    stream = io.StringIO()
    configure_logging(level=logging.INFO, log_format="json", worker_id="cfg-worker-1")

    logger = logging.getLogger("test_structured")
    # Replace handler's stream for verification
    root = logging.getLogger()
    assert len(root.handlers) > 0
    root.handlers[0].stream = stream

    set_log_context(job_id="job-configured-99", trace_id="trace-run-99")
    try:
        logger.info("Structured integration test message")
    finally:
        clear_log_context()

    output = stream.getvalue().strip()
    assert output.startswith("{") and output.endswith("}")
    parsed = json.loads(output)
    assert parsed["message"] == "Structured integration test message"
    assert parsed["job_id"] == "job-configured-99"
    assert parsed["trace_id"] == "trace-run-99"
    assert parsed["worker_id"] == "cfg-worker-1"
