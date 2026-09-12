import json
import os
import tempfile
from unittest.mock import MagicMock
import redis
from src.config import WorkerConfig
from src.artifact_collector import ArtifactCollector
from src.worker import Worker


def test_artifact_collector_scans_and_uploads_files():
    with tempfile.TemporaryDirectory() as tmp_dir:
        # Create directory structure
        dist_dir = os.path.join(tmp_dir, "dist")
        reports_dir = os.path.join(tmp_dir, "reports")
        os.makedirs(dist_dir)
        os.makedirs(reports_dir)

        file1 = os.path.join(dist_dir, "bundle.js")
        with open(file1, "w") as f:
            f.write("console.log('hello');")

        file2 = os.path.join(dist_dir, "style.css")
        with open(file2, "w") as f:
            f.write("body { margin: 0; }")

        file3 = os.path.join(reports_dir, "junit.xml")
        with open(file3, "w") as f:
            f.write("<testsuite></testsuite>")

        # Extra file not matching pattern
        file4 = os.path.join(tmp_dir, "ignore.me")
        with open(file4, "w") as f:
            f.write("ignore")

        mock_api = MagicMock()
        mock_api.upload_artifact.return_value = {"artifact": {"id": "art-1"}}

        results = ArtifactCollector.collect_and_upload(
            workspace_dir=tmp_dir,
            artifacts_config=["dist/**", "reports/*.xml"],
            api_client=mock_api,
            job_id="job-art-test",
        )

        assert len(results) == 3
        assert mock_api.upload_artifact.call_count == 3

        call_paths = [call.kwargs.get("logical_path") for call in mock_api.upload_artifact.call_args_list]
        normalized_paths = [p.replace("\\", "/") for p in call_paths]
        assert "dist/bundle.js" in normalized_paths
        assert "dist/style.css" in normalized_paths
        assert "reports/junit.xml" in normalized_paths


def test_artifact_collector_handles_dict_config():
    with tempfile.TemporaryDirectory() as tmp_dir:
        file1 = os.path.join(tmp_dir, "build.tar.gz")
        with open(file1, "wb") as f:
            f.write(b"archive bytes")

        mock_api = MagicMock()
        mock_api.upload_artifact.return_value = {"artifact": {"id": "art-dict"}}

        results = ArtifactCollector.collect_and_upload(
            workspace_dir=tmp_dir,
            artifacts_config={"paths": ["build.tar.gz"]},
            api_client=mock_api,
            job_id="job-dict-test",
        )

        assert len(results) == 1
        assert mock_api.upload_artifact.call_count == 1
        assert mock_api.upload_artifact.call_args[1]["name"] == "build.tar.gz"


def test_worker_triggers_artifact_upload_on_success():
    r = redis.Redis.from_url("redis://localhost:6379", decode_responses=True)
    config = WorkerConfig(
        redis_url="redis://localhost:6379",
        api_url="http://localhost:3000",
        worker_id="test-worker-artifacts",
    )

    worker = Worker(config)
    r.delete(worker.consumer.queue_key, worker.consumer.processing_key)

    job_id = "job-worker-artifact-test"
    r.delete(f"mini_ci:jobs:{job_id}:cancelled")

    worker.api = MagicMock()
    worker.api.get_job.return_value = {
        "id": job_id,
        "name": "build-step-with-artifact",
        "command": "echo 'artifact content' > artifact.txt",
        "status": "queued",
        "artifacts": ["artifact.txt"],
    }
    worker.api.update_job_status.return_value = {"status": "ok"}
    worker.api.upload_artifact.return_value = {"artifact": {"id": "uploaded-art-1"}}

    msg = {"jobId": job_id}
    r.lpush(worker.consumer.queue_key, json.dumps(msg))

    processed = worker.run_once(timeout_seconds=2)
    assert processed is True

    # Verify upload_artifact was called
    assert worker.api.upload_artifact.call_count == 1
    call_kwargs = worker.api.upload_artifact.call_args[1]
    assert call_kwargs["job_id"] == job_id
    assert call_kwargs["name"] == "artifact.txt"