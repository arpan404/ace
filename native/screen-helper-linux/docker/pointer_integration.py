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
    # Keep the WM's root mouse bindings out of the passive-grab fixture.
    with tempfile.NamedTemporaryFile(mode="w", suffix=".xml") as config:
        config.write('<openbox_config xmlns="http://openbox.org/3.4/rc"><focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus><mouse/></openbox_config>')
        config.flush()
        launch(["openbox", "--config-file", config.name], stdout=subprocess.DEVNULL)
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
        origin = window["bounds"]
        actions = [("pointer.move", dict(x=100, y=80)),
                   ("pointer.click", dict(x=100, y=80)),
                   ("pointer.drag", dict(x=100, y=80, toX=200, toY=100)),
                   ("scroll", dict(dx=0, dy=1))]
        def refused_actions():
            before = root.query_pointer()
            for op, fields in actions:
                reply = request(op, **fields)
                assert not reply["ok"] and reply["error"]["code"] == "not_supported", reply
                assert reply["error"]["phase"] == "rejected-before-dispatch", reply
            after = root.query_pointer()
            assert (before.root_x, before.root_y) == (after.root_x, after.root_y)
            for app in [a, b]:
                assert command(app, ["status"]) == dict(presses=0, wheels=0)
        # B's passive grab remains inactive while the pointer is inside unobscured A.
        root.warp_pointer(origin["x"]+100, origin["y"]+80)
        conn.sync()
        command(b, ["passive"])
        refused_actions()
        command(b, ["unpassive"])
        # Refusal also holds when a nonactivating overlay or human pointer movement
        # changes the destination. There is no verification/press gap to exploit.
        for x, y, width, height in [(origin["x"]+10, origin["y"]+10, 300, 150), (700, 50, 200, 200)]:
            command(b, ["move", x, y, width, height])
            root.warp_pointer(x+20, y+20)
            conn.sync()
            assert root.get_full_property(active_atom, X.AnyPropertyType).value[0] == a_id
            refused_actions()
        # Even ordinary unobscured requests refuse: XTest cannot prove a recipient.
        root.warp_pointer(origin["x"]+100, origin["y"]+80)
        conn.sync()
        refused_actions()
        command(b, ["grab"])
        refused_actions()
        command(b, ["ungrab"])
        assert not request("pointer.click", x=origin["width"], y=1)["ok"]
        assert request("stop")["ok"]
        helper.stdin.close()
        assert helper.wait(timeout=20) == 0
        print("PASS: X11 buttons refuse without effects under passive/active grabs, overlays and changed pointer destinations", flush=True)
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
