import os
from typing import Any, Dict, List, Optional
import requests


class LeaseConflictError(Exception):
    """Raised when a lease renewal fails due to ownership mismatch or expiration."""
    pass


class ApiClient:
    def __init__(self, base_url: str, api_key: Optional[str] = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def close(self) -> None:
        pass

    def _get_headers(self, extra: Optional[Dict[str, str]] = None) -> Optional[Dict[str, str]]:
        headers: Dict[str, str] = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
            headers["x-api-key"] = self.api_key
        if extra:
            headers.update(extra)
        return headers if headers else None

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        headers = self._get_headers()
        kwargs: Dict[str, Any] = {"timeout": 10}
        if headers:
            kwargs["headers"] = headers
        resp = requests.get(f"{self.base_url}/jobs/{job_id}", **kwargs)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json().get("job")

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
        lease_token: Optional[str] = None,
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
        if lease_token is not None:
            payload["lease_token"] = lease_token

        headers = self._get_headers()
        kwargs: Dict[str, Any] = {"json": payload, "timeout": 10}
        if headers:
            kwargs["headers"] = headers

        resp = requests.post(
            f"{self.base_url}/jobs/{job_id}/status",
            **kwargs,
        )
        resp.raise_for_status()
        return resp.json()

    def register_worker(
        self,
        worker_id: str,
        name: str,
        address: Optional[str] = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "id": worker_id,
            "name": name,
        }
        if address is not None:
            payload["address"] = address
        if tags is not None:
            payload["tags"] = tags
        if metadata is not None:
            payload["metadata"] = metadata

        headers = self._get_headers()
        kwargs: Dict[str, Any] = {"json": payload, "timeout": 10}
        if headers:
            kwargs["headers"] = headers

        resp = requests.post(
            f"{self.base_url}/workers/register",
            **kwargs,
        )
        resp.raise_for_status()
        return resp.json()

    def heartbeat(
        self,
        worker_id: str,
        status: Optional[str] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {}
        if status is not None:
            payload["status"] = status

        headers = self._get_headers()
        kwargs: Dict[str, Any] = {"json": payload, "timeout": 10}
        if headers:
            kwargs["headers"] = headers

        resp = requests.post(
            f"{self.base_url}/workers/{worker_id}/heartbeat",
            **kwargs,
        )
        resp.raise_for_status()
        return resp.json()

    def renew_lease(
        self,
        job_id: str,
        lease_token: str,
        duration_seconds: int = 30,
    ) -> Dict[str, Any]:
        payload = {
            "lease_token": lease_token,
            "duration_seconds": duration_seconds,
        }
        headers = self._get_headers()
        kwargs: Dict[str, Any] = {"json": payload, "timeout": 10}
        if headers:
            kwargs["headers"] = headers

        resp = requests.post(
            f"{self.base_url}/jobs/{job_id}/lease/renew",
            **kwargs,
        )
        if resp.status_code == 409:
            err_data = resp.json().get("error", {})
            msg = err_data.get("message", "Lease renewal conflict")
            raise LeaseConflictError(f"Lease conflict for job {job_id}: {msg}")
        resp.raise_for_status()
        return resp.json()

    def upload_artifact(
        self,
        job_id: str,
        file_path: str,
        name: Optional[str] = None,
        logical_path: Optional[str] = None,
        mime_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        url = f"{self.base_url}/jobs/{job_id}/artifacts"
        filename = name or os.path.basename(file_path)
        relpath = logical_path or filename

        with open(file_path, "rb") as f:
            resp = requests.post(
                url,
                data={"name": filename, "path": relpath},
                files={"file": (filename, f, mime_type or "application/octet-stream")},
                headers=self._get_headers(),
                timeout=60,
            )
            resp.raise_for_status()
            return resp.json()
