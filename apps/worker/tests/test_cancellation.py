import json
import redis
import threading
import time
from unittest.mock import MagicMock
from src.config import WorkerConfig
from src.executor import CommandExecutor
from src.worker import Worker


def test_command_executor_shell_cancellation():
    cancellation_event = threading.Event()

    def cancel_after_delay():
        time.sleep(0.2)
        cancellation_event.set()

    t = threading.Thread(target=cancel_after_delay, daemon=True)
    t.start()

    start = time.time()
    result = CommandExecutor.execute(
        command="python3 -c 'import time; time.sleep(10)'",
        cancellation_event=cancellation_event,
    )
    elapsed = time.time() - start

    assert result.exit_code == -1
    assert result.error == "Cancelled by user request"
    assert elapsed < 3.0


def test_worker_skips_pre_cancelled_job():
    r = redis.Redis.from_url("redis://localhost:6379", decode_responses=True)
    config = WorkerConfig(
        redis_url="redis://localhost:6379",
        api_url="http://localhost:3000",
        worker_id="test-worker-cancel-1",
    )

    worker = Worker(config)
    r.delete(worker.consumer.queue_key, worker.consumer.processing_key)

    job_id = "job-pre-cancelled-test"
    r.set(f"mini_ci:jobs:{job_id}:cancelled", "1")

    worker.api = MagicMock()
    worker.api.get_job.return_value = {
        "id": job_id,
        "name": "pre-cancelled-job",
        "command": "echo 'should not run'",
        "status": "queued",
    }

    # Enqueue job
    msg = {"jobId": job_id}
    r.lpush(worker.consumer.queue_key, json.dumps(msg))

    # Process one job
    processed = worker.run_once(timeout_seconds=1)
    assert processed is True
    # Should not have called update_job_status
    worker.api.update_job_status.assert_not_called()
    # Should have acknowledged
    assert r.llen(worker.consumer.processing_key) == 0

    # Cleanup
    r.delete(f"mini_ci:jobs:{job_id}:cancelled")


def test_worker_cancels_running_job_via_pubsub():
    r = redis.Redis.from_url("redis://localhost:6379", decode_responses=True)
    config = WorkerConfig(
        redis_url="redis://localhost:6379",
        api_url="http://localhost:3000",
        worker_id="test-worker-cancel-2",
    )

    worker = Worker(config)
    r.delete(worker.consumer.queue_key, worker.consumer.processing_key)

    job_id = "job-pubsub-cancel-test"
    r.delete(f"mini_ci:jobs:{job_id}:cancelled")

    worker.api = MagicMock()
    worker.api.get_job.return_value = {
        "id": job_id,
        "name": "long-running-job",
        "command": "python3 -c 'import time; time.sleep(10)'",
        "status": "queued",
    }
    worker.api.update_job_status.return_value = {"status": "ok"}

    msg = {"jobId": job_id}
    r.lpush(worker.consumer.queue_key, json.dumps(msg))

    def trigger_cancellation():
        time.sleep(0.3)
        r.set(f"mini_ci:jobs:{job_id}:cancelled", "1")
        r.publish(f"mini_ci:jobs:{job_id}:cancel", "cancel")

    trigger_thread = threading.Thread(target=trigger_cancellation, daemon=True)
    trigger_thread.start()

    start = time.time()
    processed = worker.run_once(timeout_seconds=2)
    elapsed = time.time() - start

    assert processed is True
    assert elapsed < 4.0
    assert worker.current_status == "ready"
    assert r.llen(worker.consumer.processing_key) == 0

    # Verify update_job_status was NOT called with succeeded or failed
    for call in worker.api.update_job_status.call_args_list:
        status_arg = call.kwargs.get("status")
        assert status_arg not in ("succeeded", "failed"), f"Unexpected status update: {status_arg}"

    # Cleanup
    r.delete(f"mini_ci:jobs:{job_id}:cancelled")