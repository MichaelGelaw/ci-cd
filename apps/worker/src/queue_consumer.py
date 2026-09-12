import json
from typing import Optional
import redis


class QueueConsumer:
    DEFAULT_QUEUE_KEY = "mini_ci:jobs:queued"
    DEFAULT_PROCESSING_KEY = "mini_ci:jobs:processing"
    QUEUE_KEY = DEFAULT_QUEUE_KEY
    PROCESSING_KEY = DEFAULT_PROCESSING_KEY

    def __init__(
        self,
        redis_url: str,
        queue_key: Optional[str] = None,
        processing_key: Optional[str] = None,
    ):
        self.redis = redis.Redis.from_url(redis_url, decode_responses=True)
        self.queue_key = queue_key or self.DEFAULT_QUEUE_KEY
        self.processing_key = processing_key or (
            f"{self.queue_key.rsplit(':', 1)[0]}:processing"
            if queue_key
            else self.DEFAULT_PROCESSING_KEY
        )

    def pop_job(self, timeout_seconds: int = 0) -> Optional[dict]:
        if timeout_seconds > 0:
            raw = self.redis.brpoplpush(self.queue_key, self.processing_key, timeout_seconds)
        else:
            raw = self.redis.rpoplpush(self.queue_key, self.processing_key)

        if not raw:
            return None

        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    def acknowledge_job(self, job_id: str) -> bool:
        items = self.redis.lrange(self.processing_key, 0, -1)
        for item in items:
            try:
                data = json.loads(item)
                if data.get("jobId") == job_id or data.get("job_id") == job_id:
                    self.redis.lrem(self.processing_key, 1, item)
                    return True
            except json.JSONDecodeError:
                pass
        return False
