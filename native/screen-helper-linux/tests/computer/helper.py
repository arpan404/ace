"""Drives `ace-screen-helper-linux --computer` over JSON lines, as the daemon's ComputerClient does."""
import json
import queue
import subprocess
import threading
import time


class Helper:
    def __init__(self, binary):
        self.process = subprocess.Popen(
            [binary, "--computer"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        self.replies = {}
        self.arrived = threading.Condition()
        self.next = 0
        threading.Thread(target=self._read, daemon=True).start()
        self.stderr = queue.Queue()
        threading.Thread(target=self._errors, daemon=True).start()

    def _read(self):
        for line in self.process.stdout:
            reply = json.loads(line)
            with self.arrived:
                self.replies[reply["id"]] = reply
                self.arrived.notify_all()

    def _errors(self):
        for line in self.process.stderr:
            self.stderr.put(line.decode(errors="replace"))

    def send(self, op, **payload):
        self.next += 1
        request_id = f"r{self.next}"
        self.write(json.dumps({"id": request_id, "op": op, **payload}) + "\n")
        return request_id

    def write(self, text):
        self.process.stdin.write(text.encode() if isinstance(text, str) else text)
        self.process.stdin.flush()

    def wait(self, request_id, timeout=40):
        deadline = time.time() + timeout
        with self.arrived:
            while request_id not in self.replies:
                left = deadline - time.time()
                if left <= 0:
                    raise TimeoutError(f"no reply to {request_id}")
                self.arrived.wait(left)
            return self.replies.pop(request_id)

    def call(self, op, timeout=40, **payload):
        return self.wait(self.send(op, **payload), timeout)

    def result(self, op, timeout=40, **payload):
        reply = self.call(op, timeout, **payload)
        if not reply["ok"]:
            raise AssertionError(f"{op} failed: {reply['error']}")
        return reply["result"]

    def close(self):
        self.process.stdin.close()
        try:
            return self.process.wait(5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            return None


def outline(state):
    return "\n".join(
        "  " * n["depth"] + f"{n['id']} {n['role']} {n.get('flags', '')} {n.get('name', '')!r} {n.get('value', '')!r} {n.get('actions', '')}"
        for n in state.get("nodes", [])
    )


def find(state, role=None, name=None, contains=None):
    for node in state.get("nodes", []):
        if role and node["role"] != role:
            continue
        if name is not None and node.get("name") != name:
            continue
        if contains and contains.lower() not in json.dumps(node).lower():
            continue
        return node
    return None
