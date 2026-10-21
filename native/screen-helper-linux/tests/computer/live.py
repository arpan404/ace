"""Live check of `--computer` against real GTK apps on X11.

Run inside a desktop session (see run-live.sh): Xvfb, a window manager and the AT-SPI bus.
Starts GNOME Text Editor (GTK4), GNOME Calculator (GTK4) and Mousepad (GTK3), then drives the
helper over stdin like the daemon's ComputerClient and checks what the model would see.
"""
import base64
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from helper import Helper, find, outline  # noqa: E402

BINARY = sys.argv[1]
failures = []


def check(name, condition, detail=""):
    print(("ok   " if condition else "FAIL ") + name + ("" if condition else f"\n     {detail}"))
    if not condition:
        failures.append(name)


def text_of(state):
    return json.dumps(state.get("nodes", []), ensure_ascii=False)


def start_apps():
    for command in (["gnome-text-editor", "--standalone"], ["gnome-calculator"], ["mousepad"]):
        subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(5)


def wire(helper):
    reply = helper.call("hello")
    hello = reply["result"]
    check("hello reports version 2 with accessibility and capture", hello["version"] == 2 and hello["accessibility"] and hello["screenRecording"], hello)
    for capability in ("click", "type", "menu", "wait_for", "cancel", "when", "outline_off"):
        check(f"hello lists {capability}", capability in hello["capabilities"], hello["capabilities"])
    helper.write(b'{"id":"big","op":"act","x":"' + b"x" * (9 * 1024 * 1024) + b'"}\n')
    big = helper.wait("big")
    check("an over-long request fails as bad_request by its id", not big["ok"] and big["error"]["code"] == "bad_request", big)
    check("the helper keeps answering after it", helper.call("hello")["ok"])
    unknown = helper.call("nonsense")
    check("an unknown op is a bad_request", unknown["error"]["code"] == "bad_request", unknown)


def apps(helper):
    listed = helper.result("apps")["apps"]
    ids = {app["bundleId"]: app for app in listed}
    for app_id in ("org.gnome.TextEditor", "org.gnome.Calculator", "org.xfce.mousepad"):
        check(f"apps lists {app_id} as running", app_id in ids and ids[app_id]["running"], listed)
    check("apps names apps from their desktop files", ids.get("org.gnome.Calculator", {}).get("name") == "Calculator", listed)
    found = helper.result("apps", query="xterm")["apps"]
    check("apps with a query includes installed apps", any(a["bundleId"] == "debian-xterm" and not a["running"] for a in found), found)
    resolved = helper.result("resolve", app="text editor")
    check("resolve finds an app by name", resolved["bundleId"] == "org.gnome.TextEditor" and resolved["running"], resolved)
    ambiguous = helper.call("resolve", app="org.gnome")
    check("resolve lists candidates when ambiguous", ambiguous["error"]["code"] == "app_ambiguous" and "Calculator" in ambiguous["error"]["message"], ambiguous)
    missing = helper.call("resolve", app="no such app at all")
    check("resolve says when nothing matches", missing["error"]["code"] == "app_not_found", missing)


def editor(helper):
    state = helper.result("state", app="org.gnome.TextEditor", screenshot=True)
    shot = state.get("screenshot")
    jpeg = base64.b64decode(shot["jpeg"]) if shot else b""
    check("state returns a JPEG screenshot", jpeg[:2] == b"\xff\xd8" and shot["width"] > 100, state.get("screenshotError"))
    if jpeg:
        open("/tmp/ace-computer-editor.jpg", "wb").write(jpeg)
    check("state names the window", state.get("window", {}).get("title", "").endswith("Text Editor"), state.get("window"))
    area = find(state, role="text area")
    check("the editor's text area is in the outline", area is not None, outline(state))
    if not area:
        return
    ids_before = {n["id"] for n in state["nodes"]}
    act = helper.result("act", app="org.gnome.TextEditor", actions=[{"type": "type", "text": "hello from ace", "id": area["id"]}])
    check("type into the text area by id", "error" not in act and act["done"][0].startswith("typed"), act.get("error"))
    after = helper.result("state", app="org.gnome.TextEditor")
    check("a second look shows the typed text", "hello from ace" in text_of(after), outline(after))
    check("ids stay stable across looks", find(after, role="text area")["id"] == area["id"] and len(ids_before & {n["id"] for n in after["nodes"]}) > 5)
    act = helper.result(
        "act",
        app="org.gnome.TextEditor",
        actions=[
            {"type": "select_text", "id": area["id"], "text": "from"},
            {"type": "key", "key": "BackSpace"},
            {"type": "wait_for", "text": "hello  ace", "timeout_ms": 2000},
        ],
    )
    check("select_text and a background Backspace edit the text", "error" not in act, act)
    act = helper.result("act", app="org.gnome.TextEditor", actions=[{"type": "set_value", "id": area["id"], "value": "replaced"}])
    check("set_value replaces the text", "replaced" in text_of(act.get("state", {})), act)
    raw = helper.result("act", app="org.gnome.TextEditor", actions=[{"type": "click", "x": 50, "y": 50}])
    background = raw.get("error", {})
    check("a raw click in the background is refused with a way forward",
          background.get("code") == "not_on_screen" and "activate" in background.get("message", ""), raw)


def calculator(helper):
    state = helper.result("state", app="calculator", screenshot=True, marks=True)
    if state.get("screenshot"):
        open("/tmp/ace-computer-calculator.jpg", "wb").write(base64.b64decode(state["screenshot"]["jpeg"]))
    check("calculator buttons are not flagged disabled", not any("disabled" in n.get("flags", []) for n in state["nodes"] if n.get("name") == "7"), outline(state))
    buttons = {n.get("name"): n["id"] for n in state["nodes"] if n["role"] in ("button", "toggle button")}
    check("calculator buttons are in the outline", all(k in buttons for k in ("7", "8", "+", "=")), outline(state))
    if not all(k in buttons for k in ("7", "8", "+", "=")):
        return
    steps = [{"type": "click", "id": buttons[k]} for k in ("7", "+", "8", "=")]
    act = helper.result("act", app="calculator", actions=steps)
    check("pressing buttons by id works in the background", "error" not in act and all(d.startswith("pressed") for d in act["done"]), act)
    check("the calculator shows 15", "15" in text_of(act.get("state", {})), outline(act.get("state", {})))
    guarded = helper.result("act", app="calculator", actions=[
        {"type": "click", "id": buttons["7"], "when": {"text": "no such text anywhere"}},
        {"type": "wait_for", "text": "15", "timeout_ms": 1000},
    ])
    check("a step whose when does not hold is skipped", guarded["done"][0] == "skipped click: condition not met", guarded)
    check("wait_for finds text that is there", guarded["done"][1].startswith("waited"), guarded)
    timeout = helper.result("act", app="calculator", actions=[{"type": "wait_for", "text": "no such text", "timeout_ms": 500}])
    check("wait_for times out with wait_timeout", timeout.get("error", {}).get("code") == "wait_timeout", timeout)
    stale = helper.result("act", app="calculator", actions=[{"type": "click", "id": 99999}])
    check("an unknown id is stale_element", stale.get("error", {}).get("code") == "stale_element", stale)


def mousepad(helper):
    state = helper.result("state", app="mousepad")
    check("mousepad reports its menu bar", "File" in state.get("menuBar", []) and "Edit" in state.get("menuBar", []), state.get("menuBar"))
    area = find(state, role="text area") or find(state, role="text field")
    check("mousepad's text view is in the outline", area is not None, outline(state))
    if not area:
        return
    act = helper.result("act", app="mousepad", actions=[
        {"type": "type", "text": "make me loud", "id": area["id"]},
        {"type": "menu", "path": ["Edit", "Select All"]},
        {"type": "menu", "path": ["Edit", "Convert", "To Uppercase"]},
    ])
    check("menu steps press items by path", "error" not in act and act["done"][1] == "chose Edit > Select All", act)
    check("the menu command changed the text", "MAKE ME LOUD" in text_of(act.get("state", {})), outline(act.get("state", {})))
    missing = helper.result("act", app="mousepad", actions=[{"type": "menu", "path": ["Edit", "Frobnicate"]}])
    check("a missing menu item lists what is there", missing.get("error", {}).get("code") == "menu_not_found" and "Select All" in missing["error"]["message"], missing)
    act = helper.result("act", app="mousepad", actions=[{"type": "activate"}, {"type": "key", "key": "ctrl+a"}, {"type": "key", "key": "Delete"}, {"type": "type", "text": "x"}])
    check("after activate, real keys reach the window", "error" not in act and act["done"][0].startswith("brought"), act)


def cancel(helper):
    started = time.time()
    act_id = helper.send("act", app="calculator", actions=[{"type": "wait", "ms": 10000}, {"type": "wait", "ms": 10}])
    time.sleep(0.5)
    cancelled = helper.call("cancel", target=act_id, timeout=2)
    check("cancel is answered at once", cancelled["ok"] and cancelled["result"]["cancelled"], cancelled)
    reply = helper.wait(act_id, timeout=5)
    error = reply.get("result", {}).get("error", {})
    check("the cancelled act stops with cancelled", error.get("code") == "cancelled" and time.time() - started < 3, reply)
    unknown = helper.call("cancel", target="nothing")
    check("cancelling an unknown request says so", unknown["result"]["cancelled"] is False, unknown)


def main():
    start_apps()
    helper = Helper(BINARY)
    try:
        for part in (wire, apps, editor, calculator, mousepad, cancel):
            try:
                part(helper)
            except Exception as error:  # a broken part must not hide the others
                check(f"{part.__name__} ran", False, repr(error))
    finally:
        code = helper.close()
        check("the helper exits cleanly on end of input", code == 0, code)
    print(f"{len(failures)} failed" if failures else "all passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
