import logging
import platform
import time
from typing import Optional
from src.config import WorkerConfig
from src.queue_consumer import QueueConsumer
from src.api_client import ApiClient
from src.executor import CommandExecutor

logger = logging.getLogger("worker")


class Worker:
    def __init__(self, config: Optional[WorkerConfig] = None):
        self.config = config or WorkerConfig()
        self.consumer = QueueConsumer(self.config.redis_url)
        self.api = ApiClient(self.config.api_url)
        self.running = False
        self.is_registered = False

    def register(self) -> bool:
        try:
            metadata = {
                "system": platform.system(),
                "release": platform.release(),
                "machine": platform.machine(),
                "python": platform.python_version(),
            }
            self.api.register_worker(
                worker_id=self.config.worker_id,
                name=self.config.worker_name,
                address=self.config.worker_address,
                tags=list(self.config.worker_tags),
                metadata=metadata,
            )
            self.is_registered = True
            logger.info(
                f"Registered worker {self.config.worker_id} ({self.config.worker_name}) with control plane"
            )
            return True
        except Exception as e:
            logger.error(
                f"Failed to register worker {self.config.worker_id} with control plane: {e}"
            )
            return False

    def heartbeat(self, status: Optional[str] = None) -> bool:
        try:
            self.api.heartbeat(self.config.worker_id, status=status)
            return True
        except Exception as e:
            logger.warning(f"Heartbeat failed for worker {self.config.worker_id}: {e}")
            return False

    def run_once(self, timeout_seconds: int = 1) -> bool:
        message = self.consumer.pop_job(timeout_seconds)
        if not message:
            return False

        job_id = message.get("jobId") or message.get("job_id")
        if not job_id:
            return False

        self._process_job(job_id)
        return True

    def _process_job(self, job_id: str) -> None:
        logger.info(f"Worker {self.config.worker_id} claimed job {job_id}")

        job = self.api.get_job(job_id)
        if not job:
            logger.error(f"Job {job_id} not found in control plane")
            self.consumer.acknowledge_job(job_id)
            return

        # If job is already cancelled or terminal, acknowledge and skip
        if job.get("status") in ("succeeded", "failed", "cancelled"):
            logger.info(f"Job {job_id} already in terminal state {job.get('status')}")
            self.consumer.acknowledge_job(job_id)
            return

        # Mark worker busy
        self.heartbeat(status="busy")

        # Transition: queued -> assigned
        try:
            self.api.update_job_status(job_id, status="assigned", worker_id=self.config.worker_id)
        except Exception as e:
            logger.warning(f"Could not transition job {job_id} to assigned: {e}")

        # Transition: assigned -> running
        try:
            self.api.update_job_status(job_id, status="running", worker_id=self.config.worker_id)
        except Exception as e:
            logger.error(f"Could not transition job {job_id} to running: {e}")
            self.heartbeat(status="ready")
            self.consumer.acknowledge_job(job_id)
            return

        # Execute
        command = job.get("command", "")
        image = job.get("image")
        timeout_seconds = job.get("timeout_seconds")

        result = CommandExecutor.execute(
            command=command,
            image=image,
            timeout_seconds=timeout_seconds,
        )

        final_status = "succeeded" if result.exit_code == 0 and not result.error else "failed"

        # Transition: running -> succeeded / failed
        try:
            self.api.update_job_status(
                job_id=job_id,
                status=final_status,
                worker_id=self.config.worker_id,
                exit_code=result.exit_code,
                stdout=result.stdout,
                stderr=result.stderr,
                error=result.error,
                duration_ms=result.duration_ms,
            )
        except Exception as e:
            logger.error(f"Failed to report final status for job {job_id}: {e}")

        # Return worker to ready state and acknowledge in Redis
        self.heartbeat(status="ready")
        self.consumer.acknowledge_job(job_id)
        logger.info(f"Job {job_id} finished with status {final_status}")

    def run_forever(self) -> None:
        self.register()
        self.running = True
        logger.info(f"Worker {self.config.worker_id} listening for jobs...")
        while self.running:
            try:
                self.run_once(self.config.poll_timeout_seconds)
            except Exception as e:
                logger.error(f"Error processing job: {e}")
                time.sleep(1)
