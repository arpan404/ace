"""The daemon's two ends of the session helper, for the live checks: stdin/stdout requests,
and the frame socket read as the daemon reads it."""
import json
import os
import socket
import subprocess
import sys
import threading
import time


class Frames:
    """The daemon's end of the helper's frame socket: every packet, in order."""

    def __init__(self, path: str):
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(path)
        os.chmod(path, 0o600)
        self.server.listen(1)
        self.packets: list[tuple[dict, bytes]] = []
        self.lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        conn, _ = self.server.accept()
        buffer = b""
        while True:
            data = conn.recv(1 << 20)
            if not data:
                return
            buffer += data
            while len(buffer) >= 4:
                length = int.from_bytes(buffer[:4], "big")
                if len(buffer) < 4 + length:
                    break
                header = json.loads(buffer[4 : 4 + length])
                end = 4 + length + header["bytes"]
                if len(buffer) < end:
                    break
                with self.lock:
                    self.packets.append((header, buffer[4 + length : end]))
                buffer = buffer[end:]

    def since(self, start: int) -> list[tuple[dict, bytes]]:
        with self.lock:
            return self.packets[start:]

    def count(self) -> int:
        with self.lock:
            return len(self.packets)

    def wait(self, start: int, accept, timeout: float = 20.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            for header, payload in self.since(start):
                if accept(header):
                    return header, payload
            time.sleep(0.05)
        return None


class Session:
    """The daemon's end of stdin/stdout."""

    def __init__(self, args: list[str], stderr=None, env=None):
        self.process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr or sys.stderr, env=env)
        self.next = 0

    def call(self, op: str, timeout: float = 30.0, **fields) -> dict:
        self.next += 1
        request = {"version": 2, "id": f"r{self.next}", "op": op, **fields}
        assert self.process.stdin and self.process.stdout
        try:
            self.process.stdin.write((json.dumps(request) + "\n").encode())
            self.process.stdin.flush()
        except BrokenPipeError:
            return {"ok": False, "error": "the helper exited"}
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.process.stdout.readline()
            if not line:
                break
            reply = json.loads(line)
            if reply.get("id") == request["id"]:
                return reply
        return {"ok": False, "error": "no reply"}
