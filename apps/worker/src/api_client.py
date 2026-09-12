from typing import Any, Dict, Optional
import requests


class ApiClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        resp = requests.get(f"{self.base_url}/jobs/{job_id}", timeout=10)
        if resp.status_code == 200:
            return resp.json().get("job")
        return None

    def update_job_status(
        self,
        job_id: str,
        status: str,
        worker_id: Optional[str] = None,
        exit_code: Optional[int] = None,
        stdout: Optional[str] = None,
        stderr: Optional[str] = None,
        error: Optional[str] = None,
        duration_ms: Optional[int] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"status": status}
        if worker_id is not None:
            payload["worker_id"] = worker_id
        if exit_code is not None:
            payload["exit_code"] = exit_code
        if stdout is not None:
            payload["stdout"] = stdout
        if stderr is not None:
            payload["stderr"] = stderr
        if error is not None:
            payload["error"] = error
        if duration_ms is not None:
            payload["duration_ms"] = duration_ms

        resp = requests.post(
            f"{self.base_url}/jobs/{job_id}/status",
            json=payload,
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json()
