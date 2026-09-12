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
    config = WorkerConfig(
        redis_url="redis://localhost:6379",
        api_url="http://localhost:3000",
        worker_id="test-worker",
    )

    worker = Worker(config)
    r.delete(worker.consumer.queue_key, worker.consumer.processing_key)

    # Mock API client to avoid needing API server running for this unit test
    worker.api = MagicMock()
    worker.api.get_job.return_value = {
        "id": "job-unit-test",
        "name": "unit-test-step",
        "command": "echo 'worker unit test'",
        "status": "queued",
    }
    worker.api.update_job_status.return_value = {"status": "ok"}

    # Enqueue a job to worker's queue
    msg = {"jobId": "job-unit-test", "workflowRunId": "run-unit-test"}
    r.lpush(worker.consumer.queue_key, json.dumps(msg))

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
    assert r.llen(worker.consumer.queue_key) == 0
    assert r.llen(worker.consumer.processing_key) == 0


def test_worker_register_calls_api():
    config = WorkerConfig(
        worker_id="worker-reg-test",
        worker_name="custom-node-name",
        worker_address="127.0.0.1:8080",
        worker_tags=["docker", "pytest"],
    )
    worker = Worker(config)
    worker.api = MagicMock()
    worker.api.register_worker.return_value = {
        "worker": {
            "id": "worker-reg-test",
            "name": "custom-node-name",
            "status": "ready",
        }
    }

    success = worker.register()
    assert success is True
    assert worker.is_registered is True
    worker.api.register_worker.assert_called_once()
    kwargs = worker.api.register_worker.call_args.kwargs
    assert kwargs["worker_id"] == "worker-reg-test"
    assert kwargs["name"] == "custom-node-name"
    assert kwargs["address"] == "127.0.0.1:8080"
    assert kwargs["tags"] == ["docker", "pytest"]
    assert "system" in kwargs["metadata"]


def test_worker_register_handles_api_failure():
    config = WorkerConfig(worker_id="worker-failing-reg")
    worker = Worker(config)
    worker.api = MagicMock()
    worker.api.register_worker.side_effect = Exception("Connection refused")

    success = worker.register()
    assert success is False
    assert worker.is_registered is False


def test_worker_heartbeat_calls_api():
    config = WorkerConfig(worker_id="worker-hb-test")
    worker = Worker(config)
    worker.api = MagicMock()
    worker.api.heartbeat.return_value = {"worker": {"id": "worker-hb-test", "status": "busy"}}

    success = worker.heartbeat(status="busy")
    assert success is True
    worker.api.heartbeat.assert_called_once_with("worker-hb-test", status="busy")


def test_worker_consumes_from_custom_queue():
    r = redis.Redis.from_url("redis://localhost:6379", decode_responses=True)
    custom_q = "mini_ci:test_custom:jobs"
    custom_proc = "mini_ci:test_custom:processing"
    r.delete(custom_q, custom_proc)

    config = WorkerConfig(
        worker_id="custom-q-worker",
        queue_key=custom_q,
    )
    worker = Worker(config)
    worker.api = MagicMock()
    worker.api.get_job.return_value = {
        "id": "job-custom-q",
        "name": "custom-step",
        "command": "echo 'custom queue works'",
        "status": "queued",
    }
    worker.api.update_job_status.return_value = {"status": "ok"}

    msg = {"jobId": "job-custom-q", "workflowRunId": "run-custom-q"}
    r.lpush(custom_q, json.dumps(msg))

    assert r.llen(custom_q) == 1
    processed = worker.run_once(timeout_seconds=1)
    assert processed is True
    assert r.llen(custom_q) == 0
    assert r.llen(custom_proc) == 0
    r.delete(custom_q, custom_proc)
