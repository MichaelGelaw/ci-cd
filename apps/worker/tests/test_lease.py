import threading
import time
from unittest.mock import MagicMock, patch
import pytest
import requests
from src.api_client import ApiClient, LeaseConflictError
from src.lease_renewer import LeaseRenewer
from src.worker import Worker
from src.config import WorkerConfig


def test_api_client_renew_lease_success():
    client = ApiClient("http://localhost:3000")
    with patch("requests.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "job": {"id": "job-1", "lease_duration_seconds": 30},
            "lease_expires_at": "2026-09-12T14:00:00Z",
        }
        mock_post.return_value = mock_resp

        result = client.renew_lease("job-1", "token-abc", 30)
        assert result["lease_expires_at"] == "2026-09-12T14:00:00Z"
        mock_post.assert_called_once_with(
            "http://localhost:3000/jobs/job-1/lease/renew",
            json={"lease_token": "token-abc", "duration_seconds": 30},
            timeout=10,
        )


def test_api_client_renew_lease_conflict():
    client = ApiClient("http://localhost:3000")
    with patch("requests.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 409
        mock_resp.json.return_value = {
            "error": {"message": "Lease ownership mismatch", "code": "LEASE_CONFLICT"}
        }
        mock_post.return_value = mock_resp

        with pytest.raises(LeaseConflictError) as exc_info:
            client.renew_lease("job-1", "token-wrong", 30)

        assert "Lease conflict" in str(exc_info.value)
        assert "Lease ownership mismatch" in str(exc_info.value)


def test_lease_renewer_renew_now_and_loop():
    mock_api = MagicMock(spec=ApiClient)
    mock_api.renew_lease.return_value = {"lease_expires_at": "2026-09-12T14:00:00Z"}

    renewer = LeaseRenewer(
        api_client=mock_api,
        job_id="job-42",
        lease_token="tok-42",
        duration_seconds=30,
        interval_seconds=0.1,
    )

    assert not renewer.is_conflict()
    assert renewer.renew_now() is True
    mock_api.renew_lease.assert_called_with(
        job_id="job-42",
        lease_token="tok-42",
        duration_seconds=30,
    )

    # Start loop, let it tick a couple of times, then stop
    renewer.start()
    time.sleep(0.35)
    renewer.stop()
    assert mock_api.renew_lease.call_count >= 3


def test_lease_renewer_conflict_detection():
    mock_api = MagicMock(spec=ApiClient)
    mock_api.renew_lease.side_effect = LeaseConflictError("Fenced out by control plane")

    conflict_called = threading.Event()

    def on_conflict():
        conflict_called.set()

    renewer = LeaseRenewer(
        api_client=mock_api,
        job_id="job-fenced",
        lease_token="tok-stale",
        duration_seconds=15,
        interval_seconds=0.1,
        on_conflict=on_conflict,
    )

    success = renewer.renew_now()
    assert success is False
    assert renewer.is_conflict() is True
    assert conflict_called.is_set()


def test_worker_process_job_with_lease():
    config = WorkerConfig(worker_id="test-worker", redis_url="redis://localhost:6379")
    worker = Worker(config)

    worker.api = MagicMock()
    worker.consumer = MagicMock()

    # Job returned from API with lease_token
    worker.api.get_job.return_value = {
        "id": "job-leased",
        "command": 'echo "hello lease"',
        "image": None,
        "timeout_seconds": 10,
        "status": "queued",
        "lease_token": "lease-uuid-999",
        "lease_duration_seconds": 30,
    }

    worker.api.update_job_status.return_value = {
        "job": {
            "id": "job-leased",
            "status": "running",
            "lease_token": "lease-uuid-999",
            "lease_duration_seconds": 30,
        }
    }

    worker._process_job("job-leased")

    # Verify status transitioned to assigned, running, succeeded
    calls = worker.api.update_job_status.call_args_list
    assert len(calls) >= 3
    assert calls[0][1]["status"] == "assigned"
    assert calls[1][1]["status"] == "running"
    assert calls[2][1]["status"] == "succeeded"
    worker.consumer.acknowledge_job.assert_called_with("job-leased")
