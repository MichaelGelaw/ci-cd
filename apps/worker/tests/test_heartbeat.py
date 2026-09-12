import time
from unittest.mock import MagicMock
from src.heartbeat import HeartbeatSender


def test_heartbeat_sender_manual_send():
    api = MagicMock()
    sender = HeartbeatSender(
        api_client=api,
        worker_id="test-worker-hb",
        interval_seconds=10,
        status_provider=lambda: "ready",
    )

    success = sender.send_now()
    assert success is True
    api.heartbeat.assert_called_once_with("test-worker-hb", status="ready")

    # Send with explicit status override
    sender.send_now(status="busy")
    api.heartbeat.assert_called_with("test-worker-hb", status="busy")


def test_heartbeat_sender_background_thread():
    api = MagicMock()
    current_status = ["ready"]

    sender = HeartbeatSender(
        api_client=api,
        worker_id="test-daemon-worker",
        interval_seconds=1,
        status_provider=lambda: current_status[0],
    )

    sender.start()
    # Wait for at least one tick
    time.sleep(1.2)

    assert api.heartbeat.call_count >= 1
    api.heartbeat.assert_any_call("test-daemon-worker", status="ready")

    # Change status dynamically
    current_status[0] = "busy"
    time.sleep(1.2)
    api.heartbeat.assert_any_call("test-daemon-worker", status="busy")

    # Stop sender and verify final offline call
    sender.stop(final_status="offline")
    api.heartbeat.assert_called_with("test-daemon-worker", status="offline")
    assert sender._thread is None


def test_heartbeat_sender_tolerates_api_errors():
    api = MagicMock()
    api.heartbeat.side_effect = Exception("Network unreachable")

    sender = HeartbeatSender(
        api_client=api,
        worker_id="error-worker",
        interval_seconds=5,
    )

    # Should not raise exception
    success = sender.send_now(status="ready")
    assert success is False
