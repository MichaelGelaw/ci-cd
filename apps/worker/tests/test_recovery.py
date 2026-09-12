from unittest.mock import MagicMock, patch
import pytest
from src.worker import Worker
from src.config import WorkerConfig


def test_worker_skips_already_recovered_job():
    config = WorkerConfig(worker_id="test-recovery-worker", redis_url="redis://localhost:6379")
    worker = Worker(config)

    worker.api = MagicMock()
    worker.consumer = MagicMock()

    # Job is already recovered and in 'retrying' status in the control plane
    worker.api.get_job.return_value = {
        "id": "job-rec-1",
        "command": "echo hello",
        "image": None,
        "timeout_seconds": 10,
        "status": "retrying",
        "attempt": 1,
        "max_attempts": 2,
    }

    worker._process_job("job-rec-1")

    # Worker must acknowledge and return to ready without attempting to run or transition
    worker.consumer.acknowledge_job.assert_called_with("job-rec-1")
    worker.api.update_job_status.assert_not_called()
    assert worker.current_status == "ready"


def test_worker_handles_fencing_when_reporting_status_for_recovered_job():
    config = WorkerConfig(worker_id="test-recovery-worker", redis_url="redis://localhost:6379")
    worker = Worker(config)

    worker.api = MagicMock()
    worker.consumer = MagicMock()

    # Job starts as queued
    worker.api.get_job.return_value = {
        "id": "job-rec-2",
        "command": "echo 'completed'",
        "image": None,
        "timeout_seconds": 10,
        "status": "queued",
        "attempt": 1,
        "max_attempts": 2,
        "lease_token": None,
    }

    # assigned and running transitions succeed
    worker.api.update_job_status.side_effect = [
        {"job": {"id": "job-rec-2", "status": "assigned"}},
        {"job": {"id": "job-rec-2", "status": "running"}},
        # Final status report fails because job was recovered by scheduler in the background
        Exception("INVALID_TRANSITION: cannot transition from retrying to succeeded"),
    ]

    with patch("src.executor.CommandExecutor.execute") as mock_exec:
        mock_exec.return_value = MagicMock(exit_code=0, stdout="done", stderr="", error=None, duration_ms=100)
        worker._process_job("job-rec-2")

    # Worker must acknowledge and return to ready without raising uncaught exception
    worker.consumer.acknowledge_job.assert_called_with("job-rec-2")
    assert worker.current_status == "ready"


def test_worker_aborts_if_running_transition_fails_due_to_recovery():
    config = WorkerConfig(worker_id="test-recovery-worker", redis_url="redis://localhost:6379")
    worker = Worker(config)

    worker.api = MagicMock()
    worker.consumer = MagicMock()

    worker.api.get_job.return_value = {
        "id": "job-rec-3",
        "command": "echo 'should not run'",
        "image": None,
        "timeout_seconds": 10,
        "status": "queued",
        "attempt": 1,
        "max_attempts": 2,
    }

    # Transitioning to running fails because job was already recovered / reassigned
    worker.api.update_job_status.side_effect = [
        {"job": {"id": "job-rec-3", "status": "assigned"}},
        Exception("INVALID_TRANSITION: cannot transition from failed to running"),
    ]

    with patch("src.executor.CommandExecutor.execute") as mock_exec:
        worker._process_job("job-rec-3")
        mock_exec.assert_not_called()

    # Job is acknowledged and worker is back to ready
    worker.consumer.acknowledge_job.assert_called_with("job-rec-3")
    assert worker.current_status == "ready"
