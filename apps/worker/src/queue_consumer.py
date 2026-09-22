import json
import logging
from typing import Optional
import redis

logger = logging.getLogger("queue_consumer")


class QueueConsumer:
    DEFAULT_QUEUE_KEY = "mini_ci:jobs:queued"
    DEFAULT_PROCESSING_KEY = "mini_ci:jobs:processing"
    QUEUE_KEY = DEFAULT_QUEUE_KEY
    PROCESSING_KEY = DEFAULT_PROCESSING_KEY

    # Lua script for atomic acknowledgment of a job from the processing list
    ACKNOWLEDGE_LUA = """
    local items = redis.call('LRANGE', KEYS[1], 0, -1)
    for i, item in ipairs(items) do
        local ok, data = pcall(cjson.decode, item)
        if ok and type(data) == 'table' then
            local jid = data.jobId or data.job_id
            if jid == ARGV[1] then
                redis.call('LREM', KEYS[1], 1, item)
                return 1
            end
        end
    end
    return 0
    """

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
        try:
            self._ack_script = self.redis.register_script(self.ACKNOWLEDGE_LUA)
        except Exception:
            self._ack_script = None

    def pop_job(self, timeout_seconds: int = 0) -> Optional[dict]:
        raw = None
        try:
            # Prefer BLMOVE/LMOVE (Redis 6.2+ standard) with fallback to BRPOPLPUSH/RPOPLPUSH
            if timeout_seconds > 0:
                try:
                    raw = self.redis.blmove(
                        self.queue_key, self.processing_key, float(timeout_seconds), "RIGHT", "LEFT"
                    )
                except (redis.ResponseError, AttributeError):
                    raw = self.redis.brpoplpush(self.queue_key, self.processing_key, timeout_seconds)
            else:
                try:
                    raw = self.redis.lmove(self.queue_key, self.processing_key, "RIGHT", "LEFT")
                except (redis.ResponseError, AttributeError):
                    raw = self.redis.rpoplpush(self.queue_key, self.processing_key)
        except Exception as e:
            logger.warning(f"Error popping job from Redis queue: {e}")
            return None

        if not raw:
            return None

        try:
            message = json.loads(raw)
            if not isinstance(message, dict) or not isinstance(message.get("jobId") or message.get("job_id"), str):
                raise ValueError("Queue payload must contain a string job identifier")
            if not (message.get("jobId") or message.get("job_id")):
                raise ValueError("Queue job identifier must not be empty")
            return message
        except (json.JSONDecodeError, ValueError) as err:
            logger.warning(
                f"Malformed non-JSON payload popped from {self.queue_key}; removing from processing: {err}"
            )
            try:
                self.redis.lrem(self.processing_key, 1, raw)
            except Exception:
                pass
            return None

    def acknowledge_job(self, job_id: str) -> bool:
        if self._ack_script is not None:
            try:
                result = self._ack_script(keys=[self.processing_key], args=[job_id])
                return bool(result == 1)
            except Exception as ex:
                logger.warning(f"Atomic Lua acknowledge failed, falling back to LRANGE/LREM: {ex}")

        # Fallback to python-side scan and remove
        items = self.redis.lrange(self.processing_key, 0, -1)
        for item in items:
            try:
                data = json.loads(item)
                if isinstance(data, dict) and (data.get("jobId") == job_id or data.get("job_id") == job_id):
                    self.redis.lrem(self.processing_key, 1, item)
                    return True
            except json.JSONDecodeError:
                pass
        return False

    def close(self) -> None:
        try:
            self.redis.close()
        except Exception:
            pass
