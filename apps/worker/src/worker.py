import logging
import platform
import time
from typing import Optional
from src.config import WorkerConfig
from src.queue_consumer import QueueConsumer
from src.api_client import ApiClient
from src.executor import CommandExecutor
from src.heartbeat import HeartbeatSender
from src.lease_renewer import LeaseRenewer

logger = logging.getLogger("worker")


class Worker:
    def __init__(self, config: Optional[WorkerConfig] = None):
        self.config = config or WorkerConfig()
        queue_key = self.config.queue_key or f"mini_ci:worker:{self.config.worker_id}:jobs"
        processing_key = f"mini_ci:worker:{self.config.worker_id}:processing"
        self.consumer = QueueConsumer(
            self.config.redis_url,
            queue_key=queue_key,
            processing_key=processing_key,
        )
        self.api = ApiClient(self.config.api_url)
        self.running = False
        self.is_registered = False
        self.current_status = "ready"
        self.heartbeat_sender = HeartbeatSender(
            api_client=self.api,
            worker_id=self.config.worker_id,
            interval_seconds=self.config.heartbeat_interval_seconds,
            status_provider=lambda: self.current_status,
        )

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
        if status is not None:
            self.current_status = status
        self.heartbeat_sender.api = self.api
        return self.heartbeat_sender.send_now(status)

    def stop(self) -> None:
        self.running = False
        self.heartbeat_sender.api = self.api
        self.heartbeat_sender.stop(final_status="offline")
        logger.info(f"Worker {self.config.worker_id} stopped cleanly")

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
            running_resp = self.api.update_job_status(job_id, status="running", worker_id=self.config.worker_id)
            if running_resp and isinstance(running_resp, dict) and running_resp.get("job"):
                job = running_resp["job"]
        except Exception as e:
            logger.error(f"Could not transition job {job_id} to running: {e}")
            self.heartbeat(status="ready")
            self.consumer.acknowledge_job(job_id)
            return

        # Start lease renewer if job has lease
        lease_token = job.get("lease_token")
        lease_duration = job.get("lease_duration_seconds") or 30
        renewer: Optional[LeaseRenewer] = None
        if lease_token:
            interval = max(0.5, float(lease_duration) / 3.0)
            renewer = LeaseRenewer(
                api_client=self.api,
                job_id=job_id,
                lease_token=lease_token,
                duration_seconds=int(lease_duration),
                interval_seconds=interval,
            )
            renewer.start()

        command = job.get("command", "")
        image = job.get("image")
        timeout_seconds = job.get("timeout_seconds")

        try:
            result = CommandExecutor.execute(
                command=command,
                image=image,
                timeout_seconds=timeout_seconds,
            )

            if renewer and renewer.is_conflict():
                logger.error(
                    f"Worker fenced out: lease for job {job_id} was lost during execution; skipping status update"
                )
            else:
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
                logger.info(f"Job {job_id} finished with status {final_status}")
        finally:
            if renewer:
                renewer.stop()
            # Return worker to ready state and acknowledge in Redis
            self.heartbeat(status="ready")
            self.consumer.acknowledge_job(job_id)

    def run_forever(self) -> None:
        self.register()
        self.heartbeat_sender.start()
        self.running = True
        logger.info(f"Worker {self.config.worker_id} listening for jobs...")
        try:
            while self.running:
                try:
                    self.run_once(self.config.poll_timeout_seconds)
                except Exception as e:
                    logger.error(f"Error processing job: {e}")
                    time.sleep(1)
        finally:
            self.stop()
