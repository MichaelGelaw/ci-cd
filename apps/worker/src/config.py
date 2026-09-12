import os
import platform
import socket
import uuid
from dataclasses import dataclass, field
from typing import List, Optional


def _default_tags() -> List[str]:
    tags_env = os.getenv("WORKER_TAGS")
    if tags_env:
        return [t.strip() for t in tags_env.split(",") if t.strip()]
    return ["docker", "shell", platform.system().lower()]


@dataclass(frozen=True)
class WorkerConfig:
    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379")
    api_url: str = os.getenv("API_URL", "http://localhost:3000")
    worker_id: str = os.getenv("WORKER_ID", f"worker-{uuid.uuid4().hex[:8]}")
    worker_name: str = os.getenv("WORKER_NAME", socket.gethostname() or "worker-node")
    worker_address: Optional[str] = os.getenv("WORKER_ADDRESS", None)
    worker_tags: List[str] = field(default_factory=_default_tags)
    poll_timeout_seconds: int = int(os.getenv("POLL_TIMEOUT_SECONDS", "2"))
