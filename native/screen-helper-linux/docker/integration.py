"""Public JSON/IPC integration against real Xvfb, Openbox, GTK and accessibility bus."""
import io
import json
import os
from pathlib import Path
import select
import socket
import struct
import subprocess
import tempfile
import time
from PIL import Image
from Xlib import X, display

processes = []
server = None
helper = None

def launch(args, **kwargs):
    p = subprocess.Popen(args, **kwargs)
    processes.append(p)
    return p

def line_until(stream, prefix):
    while True:
        line = stream.readline()
        if not line:
            raise AssertionError("Process exited waiting for " + prefix)
        if line.strip().startswith(prefix):
            return line.strip()

def read_exact(stream, count):
    data = bytearray()
    while len(data) < count:
        chunk = stream.recv(count-len(data))
        if not chunk:
            raise AssertionError("Frame channel closed")
        data.extend(chunk)
    return bytes(data)

def frame(stream):
    header = json.loads(read_exact(stream, struct.unpack(">I", read_exact(stream, 4))[0]))
    jpeg = read_exact(stream, header["bytes"])
    image = Image.open(io.BytesIO(jpeg))
    assert image.size == (header["width"], header["height"])
    assert header["seq"] == header["sequence"]
    return header, jpeg

counter = 0

def request(op, **fields):
    global counter
    counter += 1
    helper.stdin.write(json.dumps(dict(version=2, id="r"+str(counter), op=op, **fields))+"\n")
    helper.stdin.flush()
    reply = json.loads(helper.stdout.readline())
    assert reply["id"] == "r"+str(counter), reply
    return reply

def ok(op, **fields):
    reply = request(op, **fields)
    assert reply["ok"], reply
    return reply.get("data")

def flatten(node):
    return [node] + [n for child in node["children"] for n in flatten(child)]

try:
    # Xvfb's displayfd is a readiness edge, rather than a sleep.
    rd, wr = os.pipe()
    xvfb = launch(["Xvfb", "-displayfd", str(wr), "-screen", "0", "1024x768x24", "+extension", "DAMAGE", "+extension", "MIT-SHM", "-nolisten", "tcp"], pass_fds=[wr])
    os.close(wr)
    os.environ["DISPLAY"] = ":" + os.read(rd, 32).decode().strip()
    os.close(rd)
    conn = display.Display()
    root = conn.screen().root
    root.change_attributes(event_mask=X.PropertyChangeMask)
    conn.sync()
    wm = launch(["openbox"], stdout=subprocess.DEVNULL)
    while not root.get_full_property(conn.intern_atom("_NET_SUPPORTING_WM_CHECK"), X.AnyPropertyType):
        conn.next_event()
    # Enabling the accessibility bridge happens before starting GTK.
    subprocess.run(["gdbus", "call", "--session", "--dest", "org.a11y.Bus", "--object-path", "/org/a11y/bus", "--method", "org.freedesktop.DBus.Properties.Set", "org.a11y.Status", "IsEnabled", "<true>"], check=True, stdout=subprocess.DEVNULL)
    app = launch(["python3", "docker/test_app.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    line_until(app.stdout, "READY")
    while True:
        clients = root.get_full_property(conn.intern_atom("_NET_CLIENT_LIST"), X.AnyPropertyType)
        if clients is not None and len(clients.value):
            break
        conn.next_event()
    with tempfile.TemporaryDirectory(prefix="ace-screen-test-") as directory:
        path = directory + "/frames.sock"
        server = socket.socket(socket.AF_UNIX)
        server.bind(path)
        os.chmod(path, 0o600)
        server.listen(1)
        helper = launch(["target/release/ace-screen-helper-linux", "--endpoint", "unix:"+path, "--backend", "x11"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        frames, _ = server.accept()
        frames.settimeout(20)  # Deadlock guard, never a performance assertion.
        capabilities = ok("hello")
        assert capabilities["platform"] == "linux-x11" and capabilities["capture"]["changeDriven"]
        assert capabilities["uiTree"]
        window = next(w for w in ok("targets")["windows"] if w["bundleId"] == "AceScreenTest")
        target = dict(kind="window", windowId=window["windowId"], bundleId=window["bundleId"])
        denied = request("start", sessionId="denied", target=target, allowlist=[], fps=10)
        assert not denied["ok"] and denied["error"]["code"] == "permission_denied"
        ok("start", sessionId="integration", target=target, allowlist=["AceScreenTest"], fps=10)
        first, jpeg = frame(frames)
        assert first["width"] == 400 and first["height"] == 300
        # Scope registration can arrive after map. Retry a stopped start only on missing AT-SPI scope.
        tree_reply = request("ui.tree", maxDepth=8, maxNodes=128)
        if not tree_reply["ok"]:
            # The accessibility registry receives registration over D-Bus independently of X11 mapping.
            # The public stop/start boundary re-resolves it; no timed sleeps or mocked bus.
            for _ in range(32):
                ok("stop")
                ok("start", sessionId="integration", target=target, allowlist=["AceScreenTest"], fps=10)
                tree_reply = request("ui.tree", maxDepth=8, maxNodes=128)
                if tree_reply["ok"]:
                    break
        assert tree_reply["ok"], tree_reply
        tree = tree_reply["data"]
        nodes = flatten(tree["tree"])
        entry = next(n for n in nodes if n["name"] == "Message")
        button = next(n for n in nodes if n["name"] == "Change")
        wrong_scope = dict(target, windowId=target["windowId"]+1)
        assert request("ui.tree", target=wrong_scope, maxDepth=8, maxNodes=128)["error"]["code"] == "target_gone"
        capped = ok("ui.tree", maxDepth=0, maxNodes=1)
        assert capped["truncated"] and len(flatten(capped["tree"])) == 1
        assert ok("ui.find", query=dict(name="Message"), limit=1)["nodes"][0]["ref"] == entry["ref"]
        assert ok("ui.act", ref=entry["ref"], action="setValue", value="héllo λ")["fallback"] is False
        assert line_until(app.stdout, "TEXT:") == "TEXT:héllo λ"
        ok("ui.act", ref=entry["ref"], action="focus")
        # Wait on WM property events only if activation has not completed yet.
        while root.get_full_property(conn.intern_atom("_NET_ACTIVE_WINDOW"), X.AnyPropertyType).value[0] != target["windowId"]:
            conn.next_event()
        ok("key.press", key="End", modifiers=[])
        ok("text.type", text=" 世界")
        assert line_until(app.stdout, "TEXT:") == "TEXT:héllo λ 世界"
        # The named key must release modifiers before the following ordinary key.
        ok("key.press", key="a", modifiers=["control"])
        ok("key.press", key="End", modifiers=[])
        ok("key.press", key="b", modifiers=[])
        assert line_until(app.stdout, "TEXT:") == "TEXT:héllo λ 世界b"
        ok("key.press", key="Enter", modifiers=[])
        line_until(app.stdout, "KEY:65293")
        b = button["bounds"]
        origin = window["bounds"]
        ok("pointer.click", x=b["x"]-origin["x"]+b["w"]/2, y=b["y"]-origin["y"]+b["h"]/2, button="left")
        assert line_until(app.stdout, "CLICKED") == "CLICKED"
        ok("ui.act", ref=button["ref"], action="press")
        assert line_until(app.stdout, "CLICKED") == "CLICKED"
        header, changed = frame(frames)
        assert changed != jpeg
        assert request("pointer.click", x=9999, y=1)["error"]["code"] == "bounds"
        assert request("ui.act", ref="missing", action="press")["error"]["code"] == "target_gone"
        # EWMH window identity must independently reject forged allowlist ownership.
        ok("stop")
        impostor = {**target, "bundleId":"OtherApp"}
        assert request("start", sessionId="other", target=impostor, allowlist=["OtherApp"], fps=10)["error"]["code"] == "permission_denied"
        # Measure a real idle window and changing window. Numbers are non-gating.
        ok("start", sessionId="bench", target=target, allowlist=["AceScreenTest"], fps=10)
        frame(frames)
        import sys
        sys.path.insert(0,"bench")
        from session import measure
        def animate():
            app.stdin.write("animate\n"); app.stdin.flush()
        print(json.dumps(measure(helper.pid,frames,frame,animate)),flush=True)
        subprocess.run(["target/release/examples/encode"],check=True)
        app.stdin.write("large\n"); app.stdin.flush(); line_until(app.stdout, "LARGE")
        begin=time.perf_counter(); large=ok("ui.tree", maxDepth=8,maxNodes=512); elapsed=time.perf_counter()-begin
        print(json.dumps({"tree_nodes":len(flatten(large["tree"])),"ui_tree_ms":elapsed*1000,"rss_kib":int(Path('/proc/'+str(helper.pid)+'/status').read_text().split('VmRSS:')[1].split()[0])}), flush=True)
        ok("stop")
        helper.stdin.close(); assert helper.wait(timeout=20) == 0
        print("PASS: XShm JPEG, XDamage changes, XTest input, AT-SPI tree/caps/find/actions, approval and bounds", flush=True)
        frames.close()
finally:
    if server:
        server.close()
    for process in reversed(processes):
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
