from unittest.mock import MagicMock
import pytest
from src.worker import Worker
from src.config import WorkerConfig


def test_worker_handles_job_transitioning_to_retrying():
    config = WorkerConfig(worker_id="test-retry-worker", redis_url="redis://localhost:6379")
    worker = Worker(config)

    worker.api = MagicMock()
    worker.consumer = MagicMock()

    # Job on attempt 1 with max_attempts 3
    worker.api.get_job.return_value = {
        "id": "job-retry-1",
        "command": "exit 1",
        "image": None,
        "timeout_seconds": 10,
        "status": "queued",
        "attempt": 1,
        "max_attempts": 3,
        "lease_token": None,
    }

    # update_job_status returns 'retrying' on failure
    worker.api.update_job_status.side_effect = [
        {"job": {"id": "job-retry-1", "status": "assigned"}},
        {"job": {"id": "job-retry-1", "status": "running"}},
        {
            "job": {
                "id": "job-retry-1",
                "status": "retrying",
                "attempt": 1,
                "max_attempts": 3,
                "next_retry_at": "2026-09-12T14:10:00Z",
            }
        },
    ]

    worker._process_job("job-retry-1")

    # Verify worker acknowledged the job and returned to ready
    worker.consumer.acknowledge_job.assert_called_with("job-retry-1")
    assert worker.current_status == "ready"


def test_worker_processes_retried_attempt_success():
    config = WorkerConfig(worker_id="test-retry-worker", redis_url="redis://localhost:6379")
    worker = Worker(config)

    worker.api = MagicMock()
    worker.consumer = MagicMock()

    # Job on attempt 2
    worker.api.get_job.return_value = {
        "id": "job-retry-2",
        "command": "echo 'success on retry'",
        "image": None,
        "timeout_seconds": 10,
        "status": "queued",
        "attempt": 2,
        "max_attempts": 3,
        "lease_token": "lease-tok-2",
        "lease_duration_seconds": 30,
    }

    worker.api.update_job_status.side_effect = [
        {"job": {"id": "job-retry-2", "status": "assigned"}},
        {
            "job": {
                "id": "job-retry-2",
                "status": "running",
                "lease_token": "lease-tok-2",
                "lease_duration_seconds": 30,
            }
        },
        {"job": {"id": "job-retry-2", "status": "succeeded"}},
    ]

    worker._process_job("job-retry-2")

    calls = worker.api.update_job_status.call_args_list
    assert len(calls) >= 3
    assert calls[2][1]["status"] == "succeeded"
    worker.consumer.acknowledge_job.assert_called_with("job-retry-2")
    assert worker.current_status == "ready"
