import json
import pytest
import redis
from src.queue_consumer import QueueConsumer


@pytest.mark.parametrize("payload", ["null", "[]", "1", '"string"', "{}", '{"jobId":42}'])
def test_queue_consumer_discards_invalid_json_shapes(payload):
    consumer = QueueConsumer("redis://localhost:6379", queue_key="mini_ci:test:invalid:queue")
    consumer.redis.delete(consumer.queue_key, consumer.processing_key)
    consumer.redis.lpush(consumer.queue_key, payload)
    assert consumer.pop_job(timeout_seconds=1) is None
    assert consumer.redis.llen(consumer.processing_key) == 0
    consumer.close()


@pytest.mark.integration
def test_queue_consumer_malformed_json_handling():
    consumer = QueueConsumer(
        redis_url="redis://localhost:6379",
        queue_key="mini_ci:test:corrupt:queue",
        processing_key="mini_ci:test:corrupt:processing",
    )
    consumer.redis.delete(consumer.queue_key, consumer.processing_key)

    # Push a non-JSON string
    consumer.redis.lpush(consumer.queue_key, "not-valid-json-{{{")

    # Popping should return None and clean up the corrupted item from processing
    popped = consumer.pop_job(timeout_seconds=1)
    assert popped is None

    # Processing queue must be empty, not holding the corrupted string
    assert consumer.redis.llen(consumer.processing_key) == 0
    consumer.close()


@pytest.mark.integration
def test_queue_consumer_atomic_acknowledge():
    consumer = QueueConsumer(
        redis_url="redis://localhost:6379",
        queue_key="mini_ci:test:ack:queue",
        processing_key="mini_ci:test:ack:processing",
    )
    consumer.redis.delete(consumer.queue_key, consumer.processing_key)

    msg1 = {"jobId": "job-ack-1", "workflowRunId": "run-1", "attempt": 1}
    msg2 = {"jobId": "job-ack-2", "workflowRunId": "run-1", "attempt": 1}

    consumer.redis.lpush(consumer.queue_key, json.dumps(msg1))
    consumer.redis.lpush(consumer.queue_key, json.dumps(msg2))

    p1 = consumer.pop_job(timeout_seconds=1)
    p2 = consumer.pop_job(timeout_seconds=1)

    assert p1 is not None and p2 is not None
    assert consumer.redis.llen(consumer.processing_key) == 2

    # Acknowledge job 1
    assert consumer.acknowledge_job("job-ack-1") is True
    assert consumer.redis.llen(consumer.processing_key) == 1

    # Acknowledge non-existent job
    assert consumer.acknowledge_job("non-existent-job") is False
    assert consumer.redis.llen(consumer.processing_key) == 1

    # Acknowledge job 2
    assert consumer.acknowledge_job("job-ack-2") is True
    assert consumer.redis.llen(consumer.processing_key) == 0
    consumer.close()
