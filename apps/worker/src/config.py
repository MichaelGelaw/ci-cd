import os
import uuid
from dataclasses import dataclass


@dataclass(frozen=True)
class WorkerConfig:
    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379")
    api_url: str = os.getenv("API_URL", "http://localhost:3000")
    worker_id: str = os.getenv("WORKER_ID", f"worker-{uuid.uuid4().hex[:8]}")
    poll_timeout_seconds: int = int(os.getenv("POLL_TIMEOUT_SECONDS", "2"))
