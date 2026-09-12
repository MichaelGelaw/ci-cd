import threading
from unittest.mock import MagicMock
from src.worker import Worker
from src.config import WorkerConfig
from src.api_client import ApiClient


def test_worker_stop_gracefully_cleans_resources():
    config = WorkerConfig(worker_id="test-stop-worker")
    worker = Worker(config=config)

    worker.api = MagicMock()
    worker.heartbeat_sender = MagicMock()
    worker.consumer = MagicMock()

    # Simulate an in-flight job cancellation event
    cancellation_event = threading.Event()
    worker.current_cancellation_event = cancellation_event
    worker.running = True

    worker.stop()

    assert worker.running is False
    assert cancellation_event.is_set()
    worker.heartbeat_sender.stop.assert_called_once_with(final_status="offline")
    worker.consumer.close.assert_called_once()
    worker.api.close.assert_called_once()


def test_worker_config_evaluated_per_instance():
    # Verify WorkerConfig default_factory produces unique IDs per instance
    c1 = WorkerConfig()
    c2 = WorkerConfig()
    assert c1.worker_id != c2.worker_id
    assert len(c1.worker_tags) > 0
    assert c1.log_ttl_seconds == 86400


def test_api_client_base_url_and_close():
    client = ApiClient(base_url="http://localhost:3000/")
    assert client.base_url == "http://localhost:3000"
    client.close()
