import pytest
from src.executor import CommandExecutor


def test_shell_execution_stdout():
    res = CommandExecutor.execute("echo 'hello python worker'")
    assert res.exit_code == 0
    assert "hello python worker" in res.stdout
    assert res.error is None
    assert res.duration_ms >= 0


def test_shell_execution_stderr():
    res = CommandExecutor.execute("echo 'error message' >&2")
    assert res.exit_code == 0
    assert "error message" in res.stderr
    assert res.error is None


def test_shell_execution_exit_code():
    res = CommandExecutor.execute("exit 42")
    assert res.exit_code == 42
    assert res.error is None


def test_shell_execution_timeout():
    res = CommandExecutor.execute("sleep 5", timeout_seconds=1)
    assert res.error is not None
    assert "timed out" in res.error
    assert res.duration_ms < 4000


def test_docker_execution():
    res = CommandExecutor.execute("echo 'hello docker'", image="alpine:latest")
    assert res.exit_code == 0
    assert "hello docker" in res.stdout
    assert res.error is None


def test_docker_execution_timeout():
    res = CommandExecutor.execute("sleep 10", image="alpine:latest", timeout_seconds=2)
    assert res.error is not None
    assert "timed out" in res.error
    assert res.duration_ms < 8000
