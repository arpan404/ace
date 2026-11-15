"""Live check of the session helper's video (docs/media/plan.md, E2) in a GNOME Wayland session.

Run inside wayland-session.sh (see run-video.sh). Shares GNOME Calculator through the real
RemoteDesktop/ScreenCast portal and PipeWire (the person's approval recorded by seed_portal.py),
reads the frame socket as the daemon does, and checks that:
  - the hello reports capture -> encode capability, and on a machine without VA-API or NVIDIA
    the last-resort encoder, said to be software;
  - `stream.configure` with H.264 moves the stream to video that ffmpeg decodes, every unit in
    order, its sequence shared with the stills before it;
  - `stream.keyframe` and `stream.image` are answered while video runs;
  - the reply says what the stream runs on, degraded on the last resort, with its sentence;
  - `stream.configure` with JPEG goes back to stills.
Needs: gnome-calculator, ffmpeg, and a Chrome or Chromium for the last-resort encoder.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time

BINARY = sys.argv[1]
HERE = os.path.dirname(__file__)
failures: list[str] = []


def check(name: str, condition: object, detail: object = "") -> None:
    print(("ok   " if condition else "FAIL ") + name + ("" if condition else f"\n     {detail}"))
    if not condition:
        failures.append(name)


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

    def __init__(self, args: list[str]):
        self.process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr)
        self.next = 0

    def call(self, op: str, timeout: float = 30.0, **fields) -> dict:
        self.next += 1
        request = {"version": 2, "id": f"r{self.next}", "op": op, **fields}
        assert self.process.stdin and self.process.stdout
        self.process.stdin.write((json.dumps(request) + "\n").encode())
        self.process.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.process.stdout.readline()
            if not line:
                break
            reply = json.loads(line)
            if reply.get("id") == request["id"]:
                return reply
        return {"ok": False, "error": "no reply"}


def nal_types(annex_b: bytes) -> list[int]:
    types, i = [], 0
    while True:
        i = annex_b.find(b"\x00\x00\x01", i)
        if i < 0 or i + 3 >= len(annex_b):
            return types
        types.append(annex_b[i + 3] & 0x1F)
        i += 3


def decoded_frames(stream: bytes) -> int:
    with tempfile.NamedTemporaryFile(suffix=".h264") as file:
        file.write(stream)
        file.flush()
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames,width,height", "-of", "json", file.name],
            capture_output=True, text=True, check=False,
        )
    try:
        return int(json.loads(probe.stdout)["streams"][0]["nb_read_frames"])
    except (KeyError, IndexError, ValueError):
        print(probe.stderr)
        return 0


def main() -> None:
    subprocess.Popen(["gnome-calculator"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(5)
    seed = os.path.join(HERE, "seed_portal.py")
    subprocess.run([sys.executable, seed, "press-escape", "org.gnome.Calculator.desktop", "Calculator"], check=False, timeout=30)
    home = tempfile.mkdtemp()
    os.chmod(home, 0o700)
    token = os.path.join(home, "restore-token")
    subprocess.run([sys.executable, seed, "grant-remote-desktop", token, "org.gnome.Calculator.desktop", "Calculator"], check=True, timeout=30)
    frames = Frames(os.path.join(home, "frames.sock"))
    helper = Session([BINARY, "--endpoint", f"unix:{home}/frames.sock", "--restore-token", token, "--data-dir", home])

    hello = helper.call("hello")["data"]
    encoders = hello.get("encoders", [])
    check("the hello lists capture -> encode capability", len(encoders) >= 1, hello)
    first = encoders[0] if encoders else {}
    software = os.environ.get("ACE_E2_EXPECT", "chrome")
    check(f"the encoder chosen here is {software}", first.get("backend") == software and first.get("state") == "ok", encoders)
    if software == "chrome":
        check("the last resort says it isn't hardware or zero copy", first.get("hardware") is False and first.get("zeroCopy") is False, first)
    check("the hello offers H.264 beside JPEG", hello.get("codecs") == ["jpeg", "h264"], hello.get("codecs"))

    started = helper.call("start", 150, sessionId="video1", target={"kind": "chooser"}, fps=10)
    check("the shared window's capture starts", started.get("ok"), started)
    still = frames.wait(0, lambda h: h["codec"] == "jpeg")
    check("stills arrive before any video", still is not None)

    mark = frames.count()
    settings = {"codec": "h264", "maxWidth": 1280, "maxHeight": 800, "fps": 30, "bitrate": 2_000_000}
    reply = helper.call("stream.configure", settings=settings, epoch=5)
    check("stream.configure answers with H.264 on the daemon's socket", reply.get("ok") and reply["data"]["codec"] == "h264" and reply["data"]["ingest"] == "off", reply)
    key = frames.wait(mark, lambda h: h["codec"] == "h264" and h.get("keyframe"))
    check("video starts at a keyframe of the picture on screen", key is not None)
    if key:
        header, payload = key
        check("the keyframe carries SPS and PPS first", nal_types(payload)[:2] == [7, 8], nal_types(payload))
        check("the keyframe names its codec", str(header.get("videoCodec", "")).startswith("avc1."), header)
    again = helper.call("stream.configure", settings=settings)
    acceleration = again.get("data", {}).get("acceleration", {})
    if software == "chrome":
        check("the last resort is reported degraded, with its sentence", acceleration.get("degraded") is True and "processor" in acceleration.get("reason", ""), again)
        check("its steps are software, on shared memory", [s["backend"] for s in acceleration.get("steps", [])] == ["cpu", "chrome"], acceleration)

    for _ in range(3):
        before = frames.count()
        helper.call("stream.keyframe")
        check("stream.keyframe is answered with a keyframe", frames.wait(before, lambda h: h["codec"] == "h264" and h.get("keyframe")) is not None)
    before = frames.count()
    helper.call("stream.image")
    check("stream.image sends a still while video runs", frames.wait(before, lambda h: h["codec"] == "jpeg") is not None)
    time.sleep(1)

    packets = frames.since(mark)
    video = [p for p in packets if p[0]["codec"] == "h264"]
    sequences = [h["seq"] for h, _ in frames.since(0)]
    check("sequences rise across stills and video, none repeated", sequences == sorted(set(sequences)), sequences)
    stream = b"".join(payload for _, payload in video)
    count = decoded_frames(stream)
    check("ffmpeg decodes every unit sent", count == len(video), (count, len(video)))
    if video:
        header = video[0][0]
        check("units are within the view's bounds", header["width"] <= 1280 and header["height"] <= 800, header)

    mark = frames.count()
    back = helper.call("stream.configure", settings={**settings, "codec": "jpeg", "fps": 10})
    check("stream.configure with JPEG goes back to stills", back.get("ok") and back["data"]["codec"] == "jpeg", back)
    check("the picture on screen follows as a still, without waiting for the desktop to change", frames.wait(mark, lambda h: h["codec"] == "jpeg") is not None)
    helper.call("stop")
    helper.process.terminate()
    subprocess.run([sys.executable, seed, "revoke-remote-desktop", token], check=False, timeout=30)
    print(f"{len(failures)} failed" if failures else "all passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
