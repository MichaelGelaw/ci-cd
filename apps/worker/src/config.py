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
    redis_url: str = field(default_factory=lambda: os.getenv("REDIS_URL", "redis://localhost:6379"))
    api_url: str = field(default_factory=lambda: os.getenv("API_URL", "http://localhost:3000"))
    worker_id: str = field(default_factory=lambda: os.getenv("WORKER_ID") or f"worker-{uuid.uuid4().hex[:8]}")
    worker_name: str = field(default_factory=lambda: os.getenv("WORKER_NAME") or socket.gethostname() or "worker-node")
    worker_address: Optional[str] = field(default_factory=lambda: os.getenv("WORKER_ADDRESS", None))
    worker_tags: List[str] = field(default_factory=_default_tags)
    poll_timeout_seconds: int = field(default_factory=lambda: int(os.getenv("POLL_TIMEOUT_SECONDS", "2")))
    queue_key: Optional[str] = field(default_factory=lambda: os.getenv("WORKER_QUEUE", None))
    heartbeat_interval_seconds: int = field(default_factory=lambda: int(os.getenv("HEARTBEAT_INTERVAL_SECONDS", "5")))
    log_ttl_seconds: int = field(default_factory=lambda: int(os.getenv("LOG_TTL_SECONDS", "86400")))
    api_key: Optional[str] = field(default_factory=lambda: os.getenv("MINI_CI_API_KEY") or os.getenv("API_KEY", None))
