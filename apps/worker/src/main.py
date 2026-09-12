import logging
import signal
import sys
from src.worker import Worker

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
)


def main():
    worker = Worker()

    def handle_signal(sig, frame):
        worker.running = False
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    worker.run_forever()


if __name__ == "__main__":
    main()
