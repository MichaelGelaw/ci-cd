import os
import tempfile
from unittest.mock import MagicMock
from src.artifact_collector import ArtifactCollector


def test_artifact_collector_prevents_path_traversal():
    mock_api = MagicMock()
    mock_api.upload_artifact.return_value = {"artifact": {"id": "1"}}

    with tempfile.TemporaryDirectory() as workspace_dir:
        # Create a file inside workspace
        valid_file = os.path.join(workspace_dir, "output.txt")
        with open(valid_file, "w") as f:
            f.write("legitimate build artifact")

        # Create a sensitive file outside workspace
        with tempfile.TemporaryDirectory() as outside_dir:
            outside_file = os.path.join(outside_dir, "secret.key")
            with open(outside_file, "w") as f:
                f.write("sensitive data")

            # Try to upload both relative outside path and absolute path
            relative_traversal = os.path.relpath(outside_file, workspace_dir)
            patterns = [
                "output.txt",
                relative_traversal,
                outside_file,
            ]

            uploaded = ArtifactCollector.collect_and_upload(
                workspace_dir=workspace_dir,
                artifacts_config=patterns,
                api_client=mock_api,
                job_id="test-job-sec",
            )

            # Only the legitimate file inside workspace should be uploaded
            assert len(uploaded) == 1
            assert mock_api.upload_artifact.call_count == 1
            call_args = mock_api.upload_artifact.call_args
            assert call_args.kwargs["name"] == "output.txt"
