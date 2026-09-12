import json
import redis
from unittest.mock import MagicMock
from src.config import WorkerConfig
from src.queue_consumer import QueueConsumer
from src.worker import Worker


def test_queue_consumer_pop_and_acknowledge():
    r = redis.Redis.from_url("redis://localhost:6379", decode_responses=True)
    r.delete(QueueConsumer.QUEUE_KEY, QueueConsumer.PROCESSING_KEY)

    consumer = QueueConsumer("redis://localhost:6379")

    # Empty queue returns None
    assert consumer.pop_job(timeout_seconds=0) is None

    # Push a message
    msg = {"jobId": "test-job-123", "workflowRunId": "test-run-456", "attempt": 1}
    r.lpush(QueueConsumer.QUEUE_KEY, json.dumps(msg))

    # Pop message
    popped = consumer.pop_job(timeout_seconds=1)
    assert popped is not None
    assert popped.get("jobId") == "test-job-123"

    # Message is now in processing queue
    assert r.llen(QueueConsumer.PROCESSING_KEY) == 1

    # Acknowledge message
    assert consumer.acknowledge_job("test-job-123") is True
    assert r.llen(QueueConsumer.PROCESSING_KEY) == 0


def test_worker_run_once_executes_and_reports():
    r = redis.Redis.from_url("redis://localhost:6379", decode_responses=True)
    r.delete(QueueConsumer.QUEUE_KEY, QueueConsumer.PROCESSING_KEY)

    config = WorkerConfig(
        redis_url="redis://localhost:6379",
        api_url="http://localhost:3000",
        worker_id="test-worker",
    )

    worker = Worker(config)

    # Mock API client to avoid needing API server running for this unit test
    worker.api = MagicMock()
    worker.api.get_job.return_value = {
        "id": "job-unit-test",
        "name": "unit-test-step",
        "command": "echo 'worker unit test'",
        "status": "queued",
    }
    worker.api.update_job_status.return_value = {"status": "ok"}

    # Enqueue a job
    msg = {"jobId": "job-unit-test", "workflowRunId": "run-unit-test"}
    r.lpush(QueueConsumer.QUEUE_KEY, json.dumps(msg))

    # Process one job
    processed = worker.run_once(timeout_seconds=1)
    assert processed is True

    # Verify status transition calls
    # 1. assigned
    worker.api.update_job_status.assert_any_call(
        "job-unit-test",
        status="assigned",
        worker_id="test-worker",
    )
    # 2. running
    worker.api.update_job_status.assert_any_call(
        "job-unit-test",
        status="running",
        worker_id="test-worker",
    )
    # 3. succeeded
    calls = worker.api.update_job_status.call_args_list
    final_call = calls[-1]
    assert final_call.kwargs.get("status") == "succeeded"
    assert final_call.kwargs.get("exit_code") == 0
    assert "worker unit test" in final_call.kwargs.get("stdout", "")

    # Verify Redis queue is acknowledged and empty
    assert r.llen(QueueConsumer.QUEUE_KEY) == 0
    assert r.llen(QueueConsumer.PROCESSING_KEY) == 0
