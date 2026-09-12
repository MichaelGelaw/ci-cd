import os
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass
from typing import Optional


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
                )
            else:
                return CommandExecutor._execute_shell(
                    command=command,
                    workspace_dir=workspace_dir,
                    timeout_seconds=timeout_seconds,
                    start_time=start_time,
                )

    @staticmethod
    def _execute_shell(
        command: str,
        workspace_dir: str,
        timeout_seconds: Optional[int],
        start_time: float,
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
            )

            try:
                stdout, stderr = proc.communicate(timeout=timeout_seconds)
                duration_ms = int((time.time() - start_time) * 1000)
                return ExecutionResult(
                    exit_code=proc.returncode,
                    stdout=stdout,
                    stderr=stderr,
                    duration_ms=duration_ms,
                )
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except OSError:
                    pass
                stdout, stderr = proc.communicate()
                duration_ms = int((time.time() - start_time) * 1000)
                return ExecutionResult(
                    exit_code=proc.returncode or -1,
                    stdout=stdout or "",
                    stderr=stderr or "",
                    duration_ms=duration_ms,
                    error=f"Step timed out after {timeout_seconds}s",
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
            )

            try:
                stdout, stderr = proc.communicate(timeout=timeout_seconds)
                duration_ms = int((time.time() - start_time) * 1000)
                return ExecutionResult(
                    exit_code=proc.returncode,
                    stdout=stdout,
                    stderr=stderr,
                    duration_ms=duration_ms,
                )
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except OSError:
                    pass
                stdout, stderr = proc.communicate()
                duration_ms = int((time.time() - start_time) * 1000)
                return ExecutionResult(
                    exit_code=proc.returncode or -1,
                    stdout=stdout or "",
                    stderr=stderr or "",
                    duration_ms=duration_ms,
                    error=f"Step timed out after {timeout_seconds}s",
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
