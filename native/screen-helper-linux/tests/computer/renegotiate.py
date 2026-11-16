"""Live check: the stream negotiates its buffers again while the helper holds one
(docs/media/plan.md, E2). Run inside wayland-session.sh (see run-renegotiate.sh), whose helper
is built with AddressSanitizer in the C shell, so touching a buffer PipeWire removed fails here.

Shares the grow fixture (grow_window.py), then makes it grow (each growth is a new stream size,
so PipeWire removes every buffer and allocates new ones) while video runs and while stills run,
asking for a keyframe or a picture at once each time, before the desktop's next buffer can
replace the held one. Checks that the helper stays up, and that what follows each growth is
the new size, never a picture read from a buffer of the old one.
"""
import os
import signal
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(__file__))
from session_wire import Frames, Session  # noqa: E402

BINARY = sys.argv[1]
HERE = os.path.dirname(__file__)
failures: list[str] = []


def check(name: str, condition: object, detail: object = "") -> None:
    print(("ok   " if condition else "FAIL ") + name + ("" if condition else f"\n     {detail}"))
    if not condition:
        failures.append(name)


def main() -> None:
    fixture = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "grow_window.py")],
        env={**os.environ, "GIO_LAUNCHED_DESKTOP_FILE": os.environ["ACE_GROW_DESKTOP_FILE"]},
    )
    time.sleep(4)
    home = tempfile.mkdtemp()
    os.chmod(home, 0o700)
    token = os.path.join(home, "restore-token")
    seed = os.path.join(HERE, "seed_portal.py")
    subprocess.run([sys.executable, seed, "grant-remote-desktop", token, "dev.ace.GrowFixture.desktop", "Grow fixture"], check=True, timeout=30)
    frames = Frames(os.path.join(home, "frames.sock"))
    log = open(os.path.join(home, "helper.log"), "w+")
    # The helper (a debug build) renegotiates its buffers every second, once it has a picture: every buffer is removed
    # and allocated again, as a resize or a move to shared memory does, while it holds one.
    env = {**os.environ, "ACE_SCREEN_TEST_REALLOCATE_MS": "1000"}
    helper = Session([BINARY, "--endpoint", f"unix:{home}/frames.sock", "--restore-token", token, "--data-dir", home], stderr=log, env=env)
    helper.call("hello")
    started = helper.call("start", 150, sessionId="grow1", target={"kind": "chooser"}, fps=10)
    check("the fixture's capture starts", started.get("ok"), started)
    first = frames.wait(0, lambda h: h["codec"] == "jpeg")
    check("a still of the fixture arrives", first is not None)
    settings = {"codec": "h264", "maxWidth": 3840, "maxHeight": 3840, "fps": 30, "bitrate": 2_000_000}
    helper.call("stream.configure", settings=settings)
    key = frames.wait(0, lambda h: h["codec"] == "h264" and h.get("keyframe"))
    check("video starts", key is not None)
    width = key[0]["width"] if key else 0

    for growth in range(3):
        mark = frames.count()
        fixture.send_signal(signal.SIGUSR1)
        time.sleep(1.2)  # a renegotiation passes while the picture before is held
        # The held buffer is from before the growth: ask for it at once, again and again,
        # while the stream negotiates.
        for _ in range(30):
            helper.call("stream.keyframe", timeout=5)
            time.sleep(0.01)
        grown = frames.wait(mark, lambda h, w=width: h["codec"] == "h264" and h.get("keyframe") and h["width"] > w)
        check(f"video after growth {growth + 1} is at the new size", grown is not None, (width, [p[0]["width"] for p in frames.since(mark)][-5:]))
        if grown:
            width = grown[0]["width"]
        check(f"the helper is still up after growth {growth + 1}", helper.process.poll() is None, helper.process.poll())

    helper.call("stream.configure", settings={**settings, "codec": "jpeg", "fps": 10})
    still = frames.wait(frames.count() - 1, lambda h: h["codec"] == "jpeg")
    still_width = still[0]["width"] if still else 0
    mark = frames.count()
    fixture.send_signal(signal.SIGUSR1)
    for _ in range(30):
        helper.call("stream.image", timeout=5)
        time.sleep(0.01)
    grown = frames.wait(mark, lambda h: h["codec"] == "jpeg" and h["width"] > still_width)
    check("stills after a growth are at the new size", grown is not None, still_width)
    check("the helper is still up at the end", helper.process.poll() is None, helper.process.poll())
    log.seek(0)
    said = log.read()
    sys.stderr.write(said)
    check("no buffer was held past its removal (PipeWire never refused one back)", "refused a buffer" not in said, said[-400:])
    check("AddressSanitizer found nothing", "AddressSanitizer" not in said, said[-400:])
    helper.call("stop")
    helper.process.terminate()
    fixture.terminate()
    print(f"{len(failures)} failed" if failures else "all passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
