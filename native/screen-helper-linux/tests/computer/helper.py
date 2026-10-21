"""Drives `ace-screen-helper-linux --computer` over JSON lines, as the daemon's ComputerClient does."""
import json
import queue
import subprocess
import threading
import time
from typing import IO, Any


class Helper:
    def __init__(self, binary: str, *args: str) -> None:
        self.process = subprocess.Popen(
            [binary, "--computer", *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        assert self.process.stdin and self.process.stdout and self.process.stderr
        self.stdin: IO[bytes] = self.process.stdin
        self.replies: dict[str, dict[str, Any]] = {}
        self.arrived = threading.Condition()
        self.next = 0
        self.stderr: queue.Queue[str] = queue.Queue()
        threading.Thread(target=self._read, args=(self.process.stdout,), daemon=True).start()
        threading.Thread(target=self._errors, args=(self.process.stderr,), daemon=True).start()

    def _read(self, stdout: IO[bytes]) -> None:
        for line in stdout:
            reply = json.loads(line)
            with self.arrived:
                self.replies[reply["id"]] = reply
                self.arrived.notify_all()

    def _errors(self, stderr: IO[bytes]) -> None:
        for line in stderr:
            self.stderr.put(line.decode(errors="replace"))

    def send(self, op: str, **payload: Any) -> str:
        self.next += 1
        request_id = f"r{self.next}"
        self.write(json.dumps({"id": request_id, "op": op, **payload}) + "\n")
        return request_id

    def write(self, text: str | bytes) -> None:
        self.stdin.write(text.encode() if isinstance(text, str) else text)
        self.stdin.flush()

    def wait(self, request_id: str, timeout: float = 40) -> dict[str, Any]:
        deadline = time.time() + timeout
        with self.arrived:
            while request_id not in self.replies:
                left = deadline - time.time()
                if left <= 0:
                    raise TimeoutError(f"no reply to {request_id}")
                self.arrived.wait(left)
            return self.replies.pop(request_id)

    def call(self, op: str, timeout: float = 40, **payload: Any) -> dict[str, Any]:
        return self.wait(self.send(op, **payload), timeout)

    def result(self, op: str, timeout: float = 40, **payload: Any) -> dict[str, Any]:
        reply = self.call(op, timeout, **payload)
        if not reply["ok"]:
            raise AssertionError(f"{op} failed: {reply['error']}")
        return reply["result"]

    def close(self) -> int | None:
        self.stdin.close()
        try:
            return self.process.wait(5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            return None


def outline(state: dict[str, Any]) -> str:
    return "\n".join(
        "  " * n["depth"] + f"{n['id']} {n['role']} {n.get('flags', '')} {n.get('name', '')!r} {n.get('value', '')!r} {n.get('actions', '')}"
        for n in state.get("nodes", [])
    )


def find(state: dict[str, Any], role: str | None = None, name: str | None = None, contains: str | None = None) -> dict[str, Any] | None:
    for node in state.get("nodes", []):
        if role and node["role"] != role:
            continue
        if name is not None and node.get("name") != name:
            continue
        if contains and contains.lower() not in json.dumps(node).lower():
            continue
        return node
    return None
