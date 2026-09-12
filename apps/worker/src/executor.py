import os
import signal
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from typing import Optional, Callable


@dataclass
class ExecutionResult:
    exit_code: Optional[int]
    stdout: str
    stderr: str
    duration_ms: int
    error: Optional[str] = None


class CommandExecutor:
    @staticmethod
    def execute(
        command: str,
        image: Optional[str] = None,
        timeout_seconds: Optional[int] = None,
        on_log_chunk: Optional[Callable[[str, str], None]] = None,
    ) -> ExecutionResult:
        with tempfile.TemporaryDirectory(prefix="mini-ci-worker-") as workspace_dir:
            start_time = time.time()
            if image:
                return CommandExecutor._execute_docker(
                    command=command,
                    image=image,
                    workspace_dir=workspace_dir,
                    timeout_seconds=timeout_seconds,
                    start_time=start_time,
                    on_log_chunk=on_log_chunk,
                )
            else:
                return CommandExecutor._execute_shell(
                    command=command,
                    workspace_dir=workspace_dir,
                    timeout_seconds=timeout_seconds,
                    start_time=start_time,
                    on_log_chunk=on_log_chunk,
                )

    @staticmethod
    def _stream_process(
        proc: subprocess.Popen,
        timeout_seconds: Optional[int],
        start_time: float,
        on_log_chunk: Optional[Callable[[str, str], None]] = None,
    ) -> ExecutionResult:
        stdout_chunks: list[str] = []
        stderr_chunks: list[str] = []
        lock = threading.Lock()

        def reader(stream_pipe, stream_name: str, accumulator: list[str]):
            try:
                for line in iter(stream_pipe.readline, ""):
                    with lock:
                        accumulator.append(line)
                        if on_log_chunk:
                            try:
                                on_log_chunk(stream_name, line)
                            except Exception:
                                pass
            finally:
                stream_pipe.close()

        t_out = threading.Thread(target=reader, args=(proc.stdout, "stdout", stdout_chunks), daemon=True)
        t_err = threading.Thread(target=reader, args=(proc.stderr, "stderr", stderr_chunks), daemon=True)
        t_out.start()
        t_err.start()

        try:
            exit_code = proc.wait(timeout=timeout_seconds)
            t_out.join(timeout=2.0)
            t_err.join(timeout=2.0)
            duration_ms = int((time.time() - start_time) * 1000)
            return ExecutionResult(
                exit_code=exit_code,
                stdout="".join(stdout_chunks),
                stderr="".join(stderr_chunks),
                duration_ms=duration_ms,
            )
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except OSError:
                pass
            t_out.join(timeout=1.0)
            t_err.join(timeout=1.0)
            duration_ms = int((time.time() - start_time) * 1000)
            return ExecutionResult(
                exit_code=proc.returncode or -1,
                stdout="".join(stdout_chunks),
                stderr="".join(stderr_chunks),
                duration_ms=duration_ms,
                error=f"Step timed out after {timeout_seconds}s",
            )

    @staticmethod
    def _execute_shell(
        command: str,
        workspace_dir: str,
        timeout_seconds: Optional[int],
        start_time: float,
        on_log_chunk: Optional[Callable[[str, str], None]] = None,
    ) -> ExecutionResult:
        try:
            proc = subprocess.Popen(
                command,
                shell=True,
                cwd=workspace_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
                text=True,
                bufsize=1,
            )
            return CommandExecutor._stream_process(
                proc=proc,
                timeout_seconds=timeout_seconds,
                start_time=start_time,
                on_log_chunk=on_log_chunk,
            )
        except Exception as e:
            duration_ms = int((time.time() - start_time) * 1000)
            return ExecutionResult(
                exit_code=None,
                stdout="",
                stderr="",
                duration_ms=duration_ms,
                error=str(e),
            )

    @staticmethod
    def _execute_docker(
        command: str,
        image: str,
        workspace_dir: str,
        timeout_seconds: Optional[int],
        start_time: float,
        on_log_chunk: Optional[Callable[[str, str], None]] = None,
    ) -> ExecutionResult:
        docker_cmd = [
            "docker",
            "run",
            "--rm",
            "-v",
            f"{workspace_dir}:/workspace",
            "-w",
            "/workspace",
            "--memory=512m",
            "--cpus=1.0",
            image,
            "sh",
            "-c",
            command,
        ]

        try:
            proc = subprocess.Popen(
                docker_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
                text=True,
                bufsize=1,
            )
            return CommandExecutor._stream_process(
                proc=proc,
                timeout_seconds=timeout_seconds,
                start_time=start_time,
                on_log_chunk=on_log_chunk,
            )
        except Exception as e:
            duration_ms = int((time.time() - start_time) * 1000)
            return ExecutionResult(
                exit_code=None,
                stdout="",
                stderr="",
                duration_ms=duration_ms,
                error=str(e),
            )
