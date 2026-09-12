import signal
import sys
from src.worker import Worker
from src.logging_config import configure_logging


def main():
    worker = Worker()
    configure_logging(worker_id=worker.config.worker_id)

    def handle_signal(sig, frame):
        worker.stop()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    worker.run_forever()


if __name__ == "__main__":
    main()
