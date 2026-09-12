import json
import subprocess
import threading
import time
from unittest.mock import MagicMock
import pytest
import redis
from src.config import WorkerConfig
from src.executor import CommandExecutor
from src.worker import Worker
from src.api_client import LeaseConflictError
from src.lease_renewer import LeaseRenewer


def test_fencing_conflict_triggers_cancellation():
    """
    Simulates split-brain lease fencing: when the control plane rejects
    a lease renewal with LeaseConflictError (HTTP 409), the worker's
    cancellation_event must be signaled immediately to stop the local process.
    """
    mock_api = MagicMock()
    mock_api.renew_lease.side_effect = LeaseConflictError("Lease ownership lost")

    cancellation_event = threading.Event()
    renewer = LeaseRenewer(
        api_client=mock_api,
        job_id="fenced-job-1",
        lease_token="expired-token",
        duration_seconds=30,
        interval_seconds=0.1,
        on_conflict=cancellation_event.set,
    )

    renewer.start()
    # Wait for the renewer thread to tick and encounter the conflict
    time.sleep(0.3)
    renewer.stop()

    assert renewer.is_conflict() is True
    assert cancellation_event.is_set() is True


def test_external_container_kill_captured_as_failure():
    """
    Simulates container death outside worker control (e.g. docker kill or OOM killer).
    The executor must detect termination, capture non-zero exit code, and return cleanly.
    """
    container_name = "mini-ci-chaos-kill-test"

    def kill_container_after_delay():
        time.sleep(0.5)
        subprocess.run(["docker", "kill", container_name], capture_output=True)

    killer_thread = threading.Thread(target=kill_container_after_delay, daemon=True)
    killer_thread.start()

    start = time.time()
    result = CommandExecutor.execute(
        command="sleep 10",
        image="alpine:latest",
        container_name=container_name,
        timeout_seconds=5,
    )
    elapsed = time.time() - start

    assert result.exit_code != 0
    # Must exit well before the 5s timeout
    assert elapsed < 4.0

    # Ensure container is completely cleaned up
    check = subprocess.run(
        ["docker", "ps", "-q", "-f", f"name={container_name}"],
        capture_output=True,
        text=True,
    )
    assert container_name not in check.stdout


@pytest.mark.integration
def test_pre_execution_cancellation_race():
    """
    Simulates a race condition where a job is cancelled by the user just as
    the worker pops it from Redis. The worker must check the fast-path cancellation
    flag in Redis, avoid executing the command, acknowledge the queue item, and remain ready.
    """
    r = redis.Redis.from_url("redis://localhost:6379", decode_responses=True)
    config = WorkerConfig(
        redis_url="redis://localhost:6379",
        api_url="http://localhost:3000",
        worker_id="chaos-pre-cancel-worker",
    )
    worker = Worker(config)
    r.delete(worker.consumer.queue_key, worker.consumer.processing_key)

    job_id = "job-chaos-race-cancel"
    # Set fast-path cancelled key in Redis
    r.set(f"mini_ci:jobs:{job_id}:cancelled", "1")

    worker.api = MagicMock()
    worker.api.get_job.return_value = {
        "id": job_id,
        "name": "racy-cancelled-job",
        "command": "echo 'CRITICAL_FAILURE: this should never run'",
        "status": "queued",
    }

    # Enqueue job
    r.lpush(worker.consumer.queue_key, json.dumps({"jobId": job_id}))

    processed = worker.run_once(timeout_seconds=1)
    assert processed is True

    # Ensure status was not updated to running/succeeded
    worker.api.update_job_status.assert_not_called()
    # Ensure queue item was acknowledged from processing list
    assert r.llen(worker.consumer.processing_key) == 0

    # Cleanup
    r.delete(f"mini_ci:jobs:{job_id}:cancelled")
