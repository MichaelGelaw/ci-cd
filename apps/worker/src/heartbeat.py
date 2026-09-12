import logging
import threading
from typing import Callable, Optional
from src.api_client import ApiClient

logger = logging.getLogger("worker.heartbeat")


class HeartbeatSender:
    def __init__(
        self,
        api_client: ApiClient,
        worker_id: str,
        interval_seconds: int = 5,
        status_provider: Optional[Callable[[], Optional[str]]] = None,
    ):
        self.api = api_client
        self.worker_id = worker_id
        self.interval_seconds = max(1, interval_seconds)
        self.status_provider = status_provider
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run_loop, daemon=True, name="heartbeat-daemon"
        )
        self._thread.start()
        logger.info(
            f"Started background heartbeat daemon for worker {self.worker_id} (interval={self.interval_seconds}s)"
        )

    def stop(self, final_status: Optional[str] = "offline") -> None:
        if self._thread is None:
            if final_status is not None:
                with self._lock:
                    try:
                        self.api.heartbeat(self.worker_id, status=final_status)
                    except Exception as e:
                        logger.warning(f"Could not report final status on shutdown: {e}")
            return

        self._stop_event.set()
        self._thread.join(timeout=5.0)
        self._thread = None

        if final_status is not None:
            with self._lock:
                try:
                    self.api.heartbeat(self.worker_id, status=final_status)
                    logger.info(f"Reported final status {final_status} on worker shutdown")
                except Exception as e:
                    logger.warning(f"Could not report final status on shutdown: {e}")

    def send_now(self, status: Optional[str] = None) -> bool:
        with self._lock:
            current_status = status
            if current_status is None and self.status_provider is not None:
                current_status = self.status_provider()

            try:
                self.api.heartbeat(self.worker_id, status=current_status)
                return True
            except Exception as e:
                logger.warning(f"Heartbeat failed for worker {self.worker_id}: {e}")
                return False

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            if self._stop_event.wait(timeout=self.interval_seconds):
                break
            self.send_now()
