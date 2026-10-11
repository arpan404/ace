"""Real XTest routing against two separate fixture applications on a private Xvfb."""
import json
import os
import socket
import subprocess
import tempfile
from Xlib import X, Xatom, display

processes = []
server = None
frames = None

def launch(args, **kwargs):
    child = subprocess.Popen(args, **kwargs)
    processes.append(child)
    return child

def command(child, value):
    child.stdin.write(json.dumps(value) + "\n")
    child.stdin.flush()
    return json.loads(child.stdout.readline())

try:
    rd, wr = os.pipe()
    launch(["Xvfb", "-displayfd", str(wr), "-screen", "0", "1024x768x24", "+extension", "DAMAGE", "+extension", "MIT-SHM", "-nolisten", "tcp"], pass_fds=[wr])
    os.close(wr)
    os.environ["DISPLAY"] = ":" + os.read(rd, 32).decode().strip()
    os.close(rd)
    conn = display.Display()
    root = conn.screen().root
    root.change_attributes(event_mask=X.PropertyChangeMask)
    conn.sync()
    launch(["openbox"], stdout=subprocess.DEVNULL)
    while not root.get_full_property(conn.intern_atom("_NET_SUPPORTING_WM_CHECK"), X.AnyPropertyType):
        conn.next_event()
    a = launch(["python3", "docker/pointer_app.py", "target"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    a_id = int(a.stdout.readline().strip().split(":")[1])
    b = launch(["python3", "docker/pointer_app.py", "other"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    b_id = int(b.stdout.readline().strip().split(":")[1])
    while True:
        clients = root.get_full_property(conn.intern_atom("_NET_CLIENT_LIST"), X.AnyPropertyType)
        if clients is not None and a_id in clients.value:
            break
        conn.next_event()
    with tempfile.TemporaryDirectory(prefix="ace-pointer-test-") as directory:
        server = socket.socket(socket.AF_UNIX)
        path = directory + "/frames.sock"
        server.bind(path)
        os.chmod(path, 0o600)
        server.listen(1)
        helper = launch(["target/release/ace-screen-helper-linux", "--endpoint", "unix:"+path, "--backend", "x11"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        frames, _ = server.accept()
        counter = [0]
        def request(op, **fields):
            counter[0] += 1
            helper.stdin.write(json.dumps(dict(version=2, id="p"+str(counter[0]), op=op, **fields))+"\n")
            helper.stdin.flush()
            return json.loads(helper.stdout.readline())
        window = next(w for w in request("targets")["data"]["windows"] if w["windowId"] == a_id)
        target = dict(kind="window", windowId=a_id, bundleId="AcePointerTarget")
        assert request("start", sessionId="pointer", target=target, allowlist=["AcePointerTarget"], fps=1)["ok"]
        active_atom = conn.intern_atom("_NET_ACTIVE_WINDOW")
        while root.get_full_property(active_atom, X.AnyPropertyType).value[0] != a_id:
            conn.next_event()
        # Put the physical pointer over B while A remains the active keyboard target.
        root.warp_pointer(750, 100)
        conn.sync()
        assert root.get_full_property(active_atom, X.AnyPropertyType).value[0] == a_id
        reply = request("scroll", dx=0, dy=1)
        assert reply["ok"], reply
        assert command(a, ["status"])["wheels"] == 1
        assert command(b, ["status"])["wheels"] == 0
        # A nonactivating B covers the centre of A, so neither click nor drag may press.
        origin = window["bounds"]
        command(b, ["move", origin["x"]+10, origin["y"]+10, 300, 150])
        for op, fields in [("pointer.click", {}), ("pointer.drag", dict(toX=200, toY=100))]:
            reply = request(op, x=100, y=80, **fields)
            assert not reply["ok"] and reply["error"]["code"] == "busy", reply
        assert command(a, ["status"])["presses"] == 0
        assert command(b, ["status"])["presses"] == 0
        command(b, ["move", 700, 50, 200, 200])
        assert request("pointer.click", x=100, y=80)["ok"]
        assert command(a, ["status"])["presses"] == 1
        # An unapproved explicit grab must also refuse before any synthetic press.
        command(b, ["grab"])
        reply = request("pointer.click", x=100, y=80)
        assert not reply["ok"] and reply["error"]["code"] == "busy", reply
        command(b, ["ungrab"])
        assert command(b, ["status"])["presses"] == 0
        assert not request("pointer.click", x=origin["width"], y=1)["ok"]
        assert request("stop")["ok"]
        helper.stdin.close()
        assert helper.wait(timeout=20) == 0
        print("PASS: real X11 scroll destination, covered click/drag refusal, normal click, pointer grab refusal and exclusive bounds", flush=True)
finally:
    if frames:
        frames.close()
    if server:
        server.close()
    for child in reversed(processes):
        if child.poll() is None:
            child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
