import logging
import threading
from typing import Callable, Optional
from src.api_client import ApiClient, LeaseConflictError

logger = logging.getLogger("lease_renewer")


class LeaseRenewer:
    def __init__(
        self,
        api_client: ApiClient,
        job_id: str,
        lease_token: str,
        duration_seconds: int = 30,
        interval_seconds: float = 10.0,
        on_conflict: Optional[Callable[[], None]] = None,
    ):
        self.api = api_client
        self.job_id = job_id
        self.lease_token = lease_token
        self.duration_seconds = duration_seconds
        self.interval_seconds = max(0.1, interval_seconds)
        self.on_conflict = on_conflict

        self._stop_event = threading.Event()
        self._conflict_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._conflict_event.clear()
        self._thread = threading.Thread(
            target=self._run_loop,
            daemon=True,
            name=f"lease-renewer-{self.job_id}",
        )
        self._thread.start()
        logger.debug(f"Started lease renewer thread for job {self.job_id}")

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        logger.debug(f"Stopped lease renewer for job {self.job_id}")

    def is_conflict(self) -> bool:
        return self._conflict_event.is_set()

    def renew_now(self) -> bool:
        try:
            self.api.renew_lease(
                job_id=self.job_id,
                lease_token=self.lease_token,
                duration_seconds=self.duration_seconds,
            )
            return True
        except LeaseConflictError as e:
            logger.error(f"Lease conflict detected for job {self.job_id}: {e}")
            self._conflict_event.set()
            if self.on_conflict:
                try:
                    self.on_conflict()
                except Exception as cb_err:
                    logger.error(f"Error in lease conflict callback: {cb_err}")
            return False
        except Exception as e:
            logger.warning(f"Failed to renew lease for job {self.job_id}: {e}")
            return False

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            if self._stop_event.wait(timeout=self.interval_seconds):
                break
            if self._stop_event.is_set():
                break

            success = self.renew_now()
            if not success and self.is_conflict():
                # Lease lost / fenced; stop background thread
                break
