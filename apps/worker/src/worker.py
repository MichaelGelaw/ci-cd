import json
import logging
import platform
import threading
import tempfile
import time
from datetime import datetime, timezone
from typing import Optional
from src.config import WorkerConfig
from src.queue_consumer import QueueConsumer
from src.api_client import ApiClient
from src.executor import CommandExecutor
from src.heartbeat import HeartbeatSender
from src.lease_renewer import LeaseRenewer
from src.artifact_collector import ArtifactCollector
from src.logging_config import set_log_context, clear_log_context

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
        self.current_cancellation_event: Optional[threading.Event] = None
        set_log_context(worker_id=self.config.worker_id)

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
        if self.current_cancellation_event is not None:
            try:
                self.current_cancellation_event.set()
            except Exception:
                pass
        self.heartbeat_sender.api = self.api
        self.heartbeat_sender.stop(final_status="offline")
        self.consumer.close()
        self.api.close()
        logger.info(f"Worker {self.config.worker_id} stopped cleanly")

    def run_once(self, timeout_seconds: int = 1) -> bool:
        message = self.consumer.pop_job(timeout_seconds)
        if not message:
            return False

        job_id = message.get("jobId") or message.get("job_id")
        if not job_id:
            return False

        trace_id = message.get("traceId") or message.get("correlationId") or job_id
        self._process_job(job_id, trace_id=trace_id)
        return True

    def _process_job(self, job_id: str, trace_id: Optional[str] = None) -> None:
        set_log_context(job_id=job_id, trace_id=trace_id or job_id, worker_id=self.config.worker_id)
        try:
            self._execute_job(job_id)
        finally:
            clear_log_context()

    def _execute_job(self, job_id: str) -> None:
        logger.info(f"Worker {self.config.worker_id} claimed job {job_id}")

        job = self.api.get_job(job_id)
        if not job:
            logger.error(f"Job {job_id} not found in control plane")
            self.consumer.acknowledge_job(job_id)
            return

        # If job is already cancelled, terminal, or retrying, acknowledge and skip
        is_cancelled = False
        try:
            res = self.consumer.redis.exists(f"mini_ci:jobs:{job_id}:cancelled")
            is_cancelled = bool(res == 1 or res is True)
        except Exception:
            pass

        if is_cancelled or job.get("status") in ("succeeded", "failed", "cancelled", "retrying"):
            logger.info(f"Job {job_id} already in terminal, retrying, or cancelled state")
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

        # Setup cancellation listener and event
        cancellation_event = threading.Event()
        self.current_cancellation_event = cancellation_event
        cancel_pubsub = None
        cancel_channel = f"mini_ci:jobs:{job_id}:cancel"
        try:
            cancel_pubsub = self.consumer.redis.pubsub()
            cancel_pubsub.subscribe(cancel_channel)

            def cancel_listener():
                try:
                    for msg in cancel_pubsub.listen():
                        if msg and msg.get("type") == "message":
                            logger.info(f"Cancellation signal received for job {job_id}")
                            cancellation_event.set()
                            break
                except Exception:
                    pass

            cancel_thread = threading.Thread(target=cancel_listener, daemon=True)
            cancel_thread.start()
        except Exception as e:
            logger.warning(f"Failed to subscribe to cancellation channel for job {job_id}: {e}")

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
                on_conflict=cancellation_event.set,
            )
            renewer.start()

        command = job.get("command", "")
        image = job.get("image")
        timeout_seconds = job.get("timeout_seconds")
        attempt_num = job.get("attempt", 1)

        def on_log_chunk(stream_name: str, line_text: str):
            payload = json.dumps({
                "jobId": job_id,
                "stream": stream_name,
                "data": line_text,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "attempt": attempt_num,
            })
            try:
                self.consumer.redis.rpush(f"mini_ci:jobs:{job_id}:log_chunks", payload)
                self.consumer.redis.expire(
                    f"mini_ci:jobs:{job_id}:log_chunks", self.config.log_ttl_seconds
                )
                self.consumer.redis.publish(f"mini_ci:jobs:{job_id}:logs", payload)
            except Exception as ex:
                logger.warning(f"Failed to publish log chunk for job {job_id}: {ex}")

        container_name = f"mini-ci-job-{job_id}-{attempt_num}"
        try:
            with tempfile.TemporaryDirectory(prefix="mini-ci-job-") as workspace_dir:
                result = CommandExecutor.execute(
                    command=command,
                    image=image,
                    timeout_seconds=timeout_seconds,
                    on_log_chunk=on_log_chunk,
                    cancellation_event=cancellation_event,
                    container_name=container_name,
                    workspace_dir=workspace_dir,
                )

                cancelled_in_redis = False
                try:
                    res = self.consumer.redis.exists(f"mini_ci:jobs:{job_id}:cancelled")
                    cancelled_in_redis = bool(res == 1 or res is True)
                except Exception:
                    pass

                # Collect artifacts if configured and job succeeded
                artifacts_config = job.get("artifacts")
                if artifacts_config and result.exit_code == 0 and not (cancellation_event.is_set() or cancelled_in_redis):
                    try:
                        ArtifactCollector.collect_and_upload(
                            workspace_dir=workspace_dir,
                            artifacts_config=artifacts_config,
                            api_client=self.api,
                            job_id=job_id,
                        )
                    except Exception as e:
                        logger.error(f"Failed to collect artifacts for job {job_id}: {e}")

            # Publish log end event
            end_payload = json.dumps({
                "jobId": job_id,
                "event": "end",
                "exitCode": result.exit_code,
                "durationMs": result.duration_ms,
            })
            try:
                self.consumer.redis.rpush(f"mini_ci:jobs:{job_id}:log_chunks", end_payload)
                self.consumer.redis.expire(
                    f"mini_ci:jobs:{job_id}:log_chunks", self.config.log_ttl_seconds
                )
                self.consumer.redis.publish(f"mini_ci:jobs:{job_id}:logs", end_payload)
            except Exception as ex:
                logger.warning(f"Failed to publish log end event for job {job_id}: {ex}")

            if cancellation_event.is_set() or cancelled_in_redis:
                logger.info(f"Job {job_id} was cancelled during execution; skipping status update")
            elif renewer and renewer.is_conflict():
                logger.error(
                    f"Worker fenced out: lease for job {job_id} was lost during execution; skipping status update"
                )
            else:
                final_status = "succeeded" if result.exit_code == 0 and not result.error else "failed"
                # Transition: running -> succeeded / failed
                try:
                    resp = self.api.update_job_status(
                        job_id=job_id,
                        status=final_status,
                        worker_id=self.config.worker_id,
                        exit_code=result.exit_code,
                        stdout=result.stdout,
                        stderr=result.stderr,
                        error=result.error,
                        duration_ms=result.duration_ms,
                    )
                    reported_job = resp.get("job", {}) if isinstance(resp, dict) else {}
                    reported_status = reported_job.get("status", final_status)
                    if reported_status == "retrying":
                        logger.info(
                            f"Job {job_id} failed attempt {job.get('attempt')}; scheduled for retry by control plane"
                        )
                    else:
                        logger.info(f"Job {job_id} finished with status {reported_status}")
                except Exception as e:
                    err_str = str(e)
                    if "INVALID_TRANSITION" in err_str or "LEASE_CONFLICT" in err_str or "409" in err_str:
                        logger.warning(
                            f"Job {job_id} was recovered or transitioned by control plane; status update ignored: {e}"
                        )
                    else:
                        logger.error(f"Failed to report final status for job {job_id}: {e}")
        finally:
            self.current_cancellation_event = None
            if cancel_pubsub:
                try:
                    cancel_pubsub.unsubscribe(cancel_channel)
                    cancel_pubsub.close()
                except Exception:
                    pass
            if renewer:
                renewer.stop()
            # Return worker to ready state and acknowledge in Redis
            self.heartbeat(status="ready")
            self.consumer.acknowledge_job(job_id)

    def run_forever(self) -> None:
        if not self.register():
            registered = False
            for attempt in range(1, 4):
                logger.warning(
                    f"Worker {self.config.worker_id} registration failed; retrying in {attempt * 2}s..."
                )
                time.sleep(attempt * 2)
                if self.register():
                    registered = True
                    break
            if not registered:
                logger.error(
                    f"Worker {self.config.worker_id} could not register with control plane. Exiting."
                )
                return

        self.heartbeat_sender.start()
        self.running = True
        logger.info(f"Worker {self.config.worker_id} listening for jobs...")
        try:
            while self.running:
                try:
                    self.run_once(self.config.poll_timeout_seconds)
                except Exception as e:
                    if not self.running:
                        break
                    logger.error(f"Error processing job: {e}")
                    time.sleep(1)
        finally:
            self.stop()
