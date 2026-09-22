from unittest.mock import MagicMock, patch

import pytest
import requests

from src.api_client import ApiClient


def test_get_job_propagates_server_errors_instead_of_treating_them_as_missing():
    response = MagicMock(status_code=503)
    response.raise_for_status.side_effect = requests.HTTPError("Service unavailable")
    with patch("src.api_client.requests.get", return_value=response):
        with pytest.raises(requests.HTTPError):
            ApiClient("http://localhost:3000").get_job("job")


def test_upload_uses_multipart_for_arbitrary_file_types(tmp_path):
    file = tmp_path / "report.json"
    file.write_bytes(b'{"result":"ok"}')
    response = MagicMock()
    response.json.return_value = {"artifact": {"id": "artifact"}}
    with patch("src.api_client.requests.post", return_value=response) as post:
        ApiClient("http://localhost:3000", api_key="test-key").upload_artifact(
            "job", str(file), logical_path="reports/report.json", mime_type="application/json"
        )
    arguments = post.call_args.kwargs
    assert arguments["data"] == {"name": "report.json", "path": "reports/report.json"}
    assert arguments["files"]["file"][0] == "report.json"
    assert arguments["files"]["file"][2] == "application/json"
    assert arguments["headers"]["Authorization"] == "Bearer test-key"
    assert "Content-Type" not in arguments["headers"]
