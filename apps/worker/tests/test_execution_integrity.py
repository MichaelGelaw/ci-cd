import json
import threading
from unittest.mock import MagicMock, patch

from src.config import WorkerConfig
from src.executor import CommandExecutor, ExecutionResult
from src.worker import Worker


def test_pre_cancelled_command_does_not_spawn(tmp_path):
    cancellation = threading.Event()
    cancellation.set()
    with patch("src.executor.subprocess.Popen") as popen:
        result = CommandExecutor.execute("touch unexpected", workspace_dir=str(tmp_path), cancellation_event=cancellation)
    popen.assert_not_called()
    assert result.error == "Cancelled by user request"


def test_non_utf8_output_does_not_drop_following_output():
    result = CommandExecutor.execute("printf '\\377hello\\n'", timeout_seconds=2)
    assert result.exit_code == 0
    assert "hello" in result.stdout


def test_worker_preserves_artifacts_and_sends_lease_with_terminal_report():
    worker = Worker(WorkerConfig(worker_id="owner"))
    worker.consumer = MagicMock()
    worker.api = MagicMock()
    worker.api.get_job.return_value = {
        "id": "job", "status": "assigned", "worker_id": "owner", "command": "true",
        "lease_token": "token", "artifacts": ["report.json"],
    }
    worker.api.update_job_status.side_effect = [
        {"job": {"status": "assigned"}}, {"job": {"status": "running"}}, {"job": {"status": "succeeded"}},
    ]
    with patch("src.worker.CommandExecutor.execute", return_value=ExecutionResult(0, "", "", 1)), \
         patch("src.worker.ArtifactCollector.collect_and_upload") as collect:
        worker._process_job("job")
    collect.assert_called_once()
    assert worker.api.update_job_status.call_args.kwargs["lease_token"] == "token"
    worker.consumer.acknowledge_job.assert_called_once_with("job")


def test_worker_keeps_message_when_terminal_reporting_fails():
    worker = Worker(WorkerConfig(worker_id="owner"))
    worker.consumer = MagicMock()
    worker.api = MagicMock()
    worker.api.get_job.return_value = {"id": "job", "status": "queued", "command": "true"}
    worker.api.update_job_status.side_effect = [{}, {}, ConnectionError("API unavailable")]
    with patch("src.worker.CommandExecutor.execute", return_value=ExecutionResult(0, "", "", 1)):
        worker._process_job("job")
    worker.consumer.acknowledge_job.assert_not_called()


def test_worker_reports_timeout_separately_from_other_failures():
    worker = Worker(WorkerConfig(worker_id="owner"))
    worker.consumer = MagicMock()
    worker.api = MagicMock()
    worker.api.get_job.return_value = {"id": "job", "status": "queued", "command": "sleep 10"}
    with patch("src.worker.CommandExecutor.execute", return_value=ExecutionResult(-1, "", "", 1000, "Step timed out after 1s")):
        worker._process_job("job")
    assert worker.api.update_job_status.call_args.kwargs["status"] == "timed_out"


def test_worker_skips_jobs_reassigned_to_another_worker():
    worker = Worker(WorkerConfig(worker_id="old-owner"))
    worker.consumer = MagicMock()
    worker.api = MagicMock()
    worker.api.get_job.return_value = {"id": "job", "status": "assigned", "worker_id": "new-owner"}
    with patch("src.worker.CommandExecutor.execute") as execute:
        worker._process_job("job")
    execute.assert_not_called()
    worker.api.update_job_status.assert_not_called()


def test_worker_reports_result_before_publishing_log_end():
    worker = Worker(WorkerConfig(worker_id="owner"))
    worker.consumer = MagicMock()
    worker.api = MagicMock()
    worker.api.get_job.return_value = {"id": "job", "status": "queued", "command": "true"}
    events = []
    worker.api.update_job_status.side_effect = lambda *args, **kwargs: events.append(kwargs["status"])
    worker.consumer.redis.publish.side_effect = lambda channel, payload: events.append(json.loads(payload)["event"])
    with patch("src.worker.CommandExecutor.execute", return_value=ExecutionResult(0, "", "", 1)):
        worker._process_job("job")
    assert events == ["assigned", "running", "succeeded", "end"]


def test_shutdown_during_startup_cancels_before_spawning():
    worker = Worker(WorkerConfig(worker_id="owner"))
    worker.consumer = MagicMock()
    worker.api = MagicMock()
    worker.api.get_job.return_value = {"id": "job", "status": "queued", "command": "true"}

    def stop_after_assignment(*args, **kwargs):
        if kwargs["status"] == "running":
            worker.request_stop()
        return {}

    worker.api.update_job_status.side_effect = stop_after_assignment
    with patch("src.executor.subprocess.Popen") as popen:
        worker._process_job("job")
    popen.assert_not_called()
    assert worker.current_status == "offline"
