from unittest.mock import MagicMock, patch
import json
import pytest
from src.executor import CommandExecutor
from src.worker import Worker
from src.config import WorkerConfig


def test_command_executor_streams_log_chunks():
    chunks = []

    def on_log_chunk(stream: str, line: str):
        chunks.append((stream, line))

    result = CommandExecutor.execute(
        command="echo 'line 1'; echo 'line 2'; echo 'error line' >&2",
        on_log_chunk=on_log_chunk,
    )

    assert result.exit_code == 0
    assert "line 1" in result.stdout
    assert "line 2" in result.stdout
    assert "error line" in result.stderr

    stdout_events = [c for c in chunks if c[0] == "stdout"]
    stderr_events = [c for c in chunks if c[0] == "stderr"]

    assert len(stdout_events) >= 2
    assert len(stderr_events) >= 1


def test_worker_publishes_log_chunks_and_end_event():
    config = WorkerConfig(worker_id="test-log-worker", redis_url="redis://localhost:6379")
    worker = Worker(config)

    worker.api = MagicMock()
    worker.consumer = MagicMock()
    mock_redis = MagicMock()
    worker.consumer.redis = mock_redis

    worker.api.get_job.return_value = {
        "id": "job-log-123",
        "command": "echo 'hello live logs'",
        "image": None,
        "timeout_seconds": 10,
        "status": "queued",
        "attempt": 1,
        "max_attempts": 1,
        "lease_token": None,
    }

    worker.api.update_job_status.side_effect = [
        {"job": {"id": "job-log-123", "status": "assigned"}},
        {"job": {"id": "job-log-123", "status": "running"}},
        {"job": {"id": "job-log-123", "status": "succeeded"}},
    ]

    with patch("src.executor.CommandExecutor.execute") as mock_exec:
        def fake_exec(command, image, timeout_seconds, on_log_chunk):
            if on_log_chunk:
                on_log_chunk("stdout", "Streaming log 1\n")
                on_log_chunk("stdout", "Streaming log 2\n")
            return MagicMock(exit_code=0, stdout="Streaming log 1\nStreaming log 2\n", stderr="", error=None, duration_ms=50)

        mock_exec.side_effect = fake_exec
        worker._process_job("job-log-123")

    # Verify Redis list push and pubsub calls were made
    assert mock_redis.rpush.call_count >= 3  # 2 chunks + 1 end event
    assert mock_redis.publish.call_count >= 3

    # Check published end event
    end_call_args = mock_redis.publish.call_args_list[-1]
    channel, payload_str = end_call_args[0]
    assert channel == "mini_ci:jobs:job-log-123:logs"
    payload = json.loads(payload_str)
    assert payload["event"] == "end"
    assert payload["exitCode"] == 0
