"""Real XTest routing against two separate fixture applications on a private Xvfb.

A person at a live view clicks, drags and scrolls the shared window; nothing reaches it, or
any other app, when another window covers the point, another app holds the pointer, or
another app grabs that button on the whole screen. An agent's pointer input is always refused.
Set ACE_POINTER_DISPLAY (a number) to use a fixed X display instead of the first free one.
"""
import json
import os
import socket
import subprocess
import tempfile
from Xlib import X, display

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

def fixture(role, desktop_id):
    # Launched as a desktop launcher would, so each fixture has its own desktop id.
    env = dict(os.environ, GIO_LAUNCHED_DESKTOP_FILE="/usr/share/applications/%s.desktop" % desktop_id)
    child = launch(["python3", "docker/pointer_app.py", role], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
    return child, int(child.stdout.readline().strip().split(":")[1])

try:
    fixed = os.environ.get("ACE_POINTER_DISPLAY")
    if fixed:
        launch(["Xvfb", ":" + fixed, "-screen", "0", "1024x768x24", "+extension", "DAMAGE", "+extension", "MIT-SHM", "-nolisten", "tcp"])
        os.environ["DISPLAY"] = ":" + fixed
        for _ in range(100):
            if os.path.exists("/tmp/.X11-unix/X" + fixed):
                break
            subprocess.run(["sleep", "0.1"])
    else:
        rd, wr = os.pipe()
        launch(["Xvfb", "-displayfd", str(wr), "-screen", "0", "1024x768x24", "+extension", "DAMAGE", "+extension", "MIT-SHM", "-nolisten", "tcp"], pass_fds=[wr])
        os.close(wr)
        os.environ["DISPLAY"] = ":" + os.read(rd, 32).decode().strip()
        os.close(rd)
    os.environ.pop("WAYLAND_DISPLAY", None)
    os.environ["XDG_SESSION_TYPE"] = "x11"
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
    a, a_id = fixture("target", "AcePointerTarget")
    b, b_id = fixture("other", "AcePointerOther")
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
        assert window["bundleId"] == "AcePointerTarget", window
        target = dict(kind="window", windowId=a_id, bundleId="AcePointerTarget")
        assert request("start", sessionId="pointer", target=target, allowlist=["AcePointerTarget"], fps=1)["ok"]
        active_atom = conn.intern_atom("_NET_ACTIVE_WINDOW")
        while root.get_full_property(active_atom, X.AnyPropertyType).value[0] != a_id:
            conn.next_event()
        origin = window["bounds"]
        actions = [("pointer.click", dict(x=100, y=80)),
                   ("pointer.drag", dict(x=100, y=80, toX=200, toY=100, durationMs=50)),
                   ("scroll", dict(x=100, y=80, dx=0, dy=80))]
        def counts():
            return [command(app, ["status"]) for app in [a, b]]
        nothing = [dict(presses=0, wheels=0), dict(presses=0, wheels=0)]
        def refused(person, code):
            before = root.query_pointer()
            for op, fields in actions:
                reply = request(op, person=person, **fields)
                assert not reply["ok"] and reply["error"]["code"] == code, reply
                assert reply["error"]["phase"] == "rejected-before-dispatch", reply
            after = root.query_pointer()
            assert (before.root_x, before.root_y) == (after.root_x, after.root_y)
            assert counts() == nothing, counts()
        root.warp_pointer(origin["x"]+100, origin["y"]+80)
        conn.sync()
        # An agent never gets X11 pointer input, even onto the unobscured approved window.
        refused(False, "not_supported")
        # Another app's passive grab on the root would take the person's click anywhere.
        command(b, ["passive"])
        refused(True, "busy")
        command(b, ["unpassive"])
        # A window over the point, active or not, takes nothing either.
        for x, y, width, height in [(origin["x"]+10, origin["y"]+10, 300, 150)]:
            command(b, ["move", x, y, width, height])
            conn.sync()
            assert root.get_full_property(active_atom, X.AnyPropertyType).value[0] == a_id
            refused(True, "busy")
        command(b, ["move", 700, 50, 200, 200])
        conn.sync()
        # Another app holding the pointer (an open menu) takes nothing.
        command(b, ["grab"])
        refused(True, "busy")
        command(b, ["ungrab"])
        # Unobscured, active and ungrabbed: the person's input reaches the approved window only.
        for op, fields in actions:
            reply = request(op, person=True, **fields)
            assert reply["ok"], reply
        status = counts()
        assert status[1] == dict(presses=0, wheels=0), status
        assert status[0]["presses"] == 2 and status[0]["wheels"] == 2, status
        assert request("pointer.click", person=True, x=origin["width"], y=1)["error"]["code"] == "bounds"
        assert request("stop")["ok"]
        helper.stdin.close()
        assert helper.wait(timeout=20) == 0
        print("PASS: a person's X11 clicks reach only the approved window; covered, grabbed and agent input is refused without effects", flush=True)
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
