import json
from typing import Optional
import redis


class QueueConsumer:
    QUEUE_KEY = "mini_ci:jobs:queued"
    PROCESSING_KEY = "mini_ci:jobs:processing"

    def __init__(self, redis_url: str):
        self.redis = redis.Redis.from_url(redis_url, decode_responses=True)

    def pop_job(self, timeout_seconds: int = 0) -> Optional[dict]:
        if timeout_seconds > 0:
            raw = self.redis.brpoplpush(self.QUEUE_KEY, self.PROCESSING_KEY, timeout_seconds)
        else:
            raw = self.redis.rpoplpush(self.QUEUE_KEY, self.PROCESSING_KEY)

        if not raw:
            return None

        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    def acknowledge_job(self, job_id: str) -> bool:
        items = self.redis.lrange(self.PROCESSING_KEY, 0, -1)
        for item in items:
            try:
                data = json.loads(item)
                if data.get("jobId") == job_id or data.get("job_id") == job_id:
                    self.redis.lrem(self.PROCESSING_KEY, 1, item)
                    return True
            except json.JSONDecodeError:
                pass
        return False
