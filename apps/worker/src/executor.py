import os
import signal
import subprocess
import sys
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


def _kill_process_safely(proc: subprocess.Popen, sig: int = signal.SIGTERM) -> None:
    """
    Cross-platform process termination helper.
    Uses proc.terminate()/proc.kill() on Windows, and process group signals on POSIX.
    """
    if sys.platform == "win32":
        try:
            proc.terminate()
            try:
                proc.wait(timeout=0.5)
            except (subprocess.TimeoutExpired, Exception):
                proc.kill()
        except Exception:
            pass
    else:
        try:
            pgid = os.getpgid(proc.pid)
            os.killpg(pgid, sig)
        except (OSError, AttributeError, ProcessLookupError):
            try:
                proc.kill()
            except Exception:
                pass


def _cleanup_container(container_name: Optional[str]) -> None:
    """Safely kills and removes a named Docker container if present."""
    if not container_name:
        return
    try:
        subprocess.run(["docker", "kill", container_name], capture_output=True, timeout=5)
    except Exception:
        pass
    try:
        subprocess.run(["docker", "rm", "-f", container_name], capture_output=True, timeout=5)
    except Exception:
        pass


class CommandExecutor:
    """
    Executes commands either in an isolated Docker container (untrusted/default CI mode)
    or directly via the host shell (trusted mode).

    Security note:
    - Docker container execution enforces memory, CPU, and filesystem sandboxing.
    - Host shell execution runs with the worker process's permissions and has no
      cgroup boundaries. Host shell mode should only be used for trusted internal workflows.
    """

    @staticmethod
    def execute(
        command: str,
        image: Optional[str] = None,
        timeout_seconds: Optional[int] = None,
        on_log_chunk: Optional[Callable[[str, str], None]] = None,
        cancellation_event: Optional[threading.Event] = None,
        container_name: Optional[str] = None,
        workspace_dir: Optional[str] = None,
        memory_limit: str = "512m",
        cpu_limit: str = "1.0",
    ) -> ExecutionResult:
        if workspace_dir:
            return CommandExecutor._run_in_workspace(
                command=command,
                workspace_dir=workspace_dir,
                image=image,
                timeout_seconds=timeout_seconds,
                on_log_chunk=on_log_chunk,
                cancellation_event=cancellation_event,
                container_name=container_name,
                memory_limit=memory_limit,
                cpu_limit=cpu_limit,
            )
        else:
            with tempfile.TemporaryDirectory(prefix="mini-ci-worker-") as temp_dir:
                return CommandExecutor._run_in_workspace(
                    command=command,
                    workspace_dir=temp_dir,
                    image=image,
                    timeout_seconds=timeout_seconds,
                    on_log_chunk=on_log_chunk,
                    cancellation_event=cancellation_event,
                    container_name=container_name,
                    memory_limit=memory_limit,
                    cpu_limit=cpu_limit,
                )

    @staticmethod
    def _run_in_workspace(
        command: str,
        workspace_dir: str,
        image: Optional[str] = None,
        timeout_seconds: Optional[int] = None,
        on_log_chunk: Optional[Callable[[str, str], None]] = None,
        cancellation_event: Optional[threading.Event] = None,
        container_name: Optional[str] = None,
        memory_limit: str = "512m",
        cpu_limit: str = "1.0",
    ) -> ExecutionResult:
        start_time = time.time()
        if image:
            return CommandExecutor._execute_docker(
                command=command,
                image=image,
                workspace_dir=workspace_dir,
                timeout_seconds=timeout_seconds,
                start_time=start_time,
                on_log_chunk=on_log_chunk,
                cancellation_event=cancellation_event,
                container_name=container_name,
                memory_limit=memory_limit,
                cpu_limit=cpu_limit,
            )
        else:
            return CommandExecutor._execute_shell(
                command=command,
                workspace_dir=workspace_dir,
                timeout_seconds=timeout_seconds,
                start_time=start_time,
                on_log_chunk=on_log_chunk,
                cancellation_event=cancellation_event,
            )

    @staticmethod
    def _stream_process(
        proc: subprocess.Popen,
        timeout_seconds: Optional[int],
        start_time: float,
        on_log_chunk: Optional[Callable[[str, str], None]] = None,
        cancellation_event: Optional[threading.Event] = None,
        container_name: Optional[str] = None,
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

        cancelled = False
        timed_out = False

        while proc.poll() is None:
            if cancellation_event and cancellation_event.is_set():
                cancelled = True
                break

            if timeout_seconds and (time.time() - start_time) > timeout_seconds:
                timed_out = True
                break

            time.sleep(0.05)

        if cancelled:
            _cleanup_container(container_name)
            _kill_process_safely(proc, signal.SIGTERM)

            try:
                proc.wait(timeout=1.0)
            except (subprocess.TimeoutExpired, Exception):
                _kill_process_safely(proc, signal.SIGKILL)

            t_out.join(timeout=1.0)
            t_err.join(timeout=1.0)
            duration_ms = int((time.time() - start_time) * 1000)
            return ExecutionResult(
                exit_code=-1,
                stdout="".join(stdout_chunks),
                stderr="".join(stderr_chunks),
                duration_ms=duration_ms,
                error="Cancelled by user request",
            )

        if timed_out:
            _cleanup_container(container_name)
            _kill_process_safely(proc, signal.SIGKILL)

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

        exit_code = proc.returncode
        t_out.join(timeout=2.0)
        t_err.join(timeout=2.0)
        duration_ms = int((time.time() - start_time) * 1000)
        return ExecutionResult(
            exit_code=exit_code,
            stdout="".join(stdout_chunks),
            stderr="".join(stderr_chunks),
            duration_ms=duration_ms,
        )

    @staticmethod
    def _execute_shell(
        command: str,
        workspace_dir: str,
        timeout_seconds: Optional[int],
        start_time: float,
        on_log_chunk: Optional[Callable[[str, str], None]] = None,
        cancellation_event: Optional[threading.Event] = None,
    ) -> ExecutionResult:
        try:
            start_session = True if sys.platform != "win32" else False
            proc = subprocess.Popen(
                command,
                shell=True,
                cwd=workspace_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=start_session,
                text=True,
                bufsize=1,
            )
            return CommandExecutor._stream_process(
                proc=proc,
                timeout_seconds=timeout_seconds,
                start_time=start_time,
                on_log_chunk=on_log_chunk,
                cancellation_event=cancellation_event,
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
        cancellation_event: Optional[threading.Event] = None,
        container_name: Optional[str] = None,
        memory_limit: str = "512m",
        cpu_limit: str = "1.0",
    ) -> ExecutionResult:
        docker_cmd = [
            "docker",
            "run",
            "--rm",
        ]
        if container_name:
            docker_cmd.append(f"--name={container_name}")

        docker_cmd.extend([
            "-v",
            f"{workspace_dir}:/workspace",
            "-w",
            "/workspace",
            f"--memory={memory_limit}",
            f"--cpus={cpu_limit}",
            image,
            "sh",
            "-c",
            command,
        ])

        try:
            start_session = True if sys.platform != "win32" else False
            proc = subprocess.Popen(
                docker_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=start_session,
                text=True,
                bufsize=1,
            )
            return CommandExecutor._stream_process(
                proc=proc,
                timeout_seconds=timeout_seconds,
                start_time=start_time,
                on_log_chunk=on_log_chunk,
                cancellation_event=cancellation_event,
                container_name=container_name,
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
