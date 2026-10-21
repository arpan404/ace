"""Live check of `--computer` in a GNOME Wayland session (see run-wayland.sh).

AT-SPI semantics work as on X11; screenshots and raw input are unavailable and must say so in
words the model can act on.
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from helper import Helper, find, outline  # noqa: E402

failures = []


def check(name, condition, detail=""):
    print(("ok   " if condition else "FAIL ") + name + ("" if condition else f"\n     {detail}"))
    if not condition:
        failures.append(name)


def main():
    for command in (["gnome-calculator"], ["gnome-text-editor", "--standalone"]):
        subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(6)
    helper = Helper(sys.argv[1])
    try:
        hello = helper.result("hello")
        check("hello reports accessibility but no capture", hello["accessibility"] and not hello["screenRecording"], hello)
        check("hello leaves out pointer-only steps", "drag" not in hello["capabilities"] and "click" in hello["capabilities"], hello)

        ids = [a["bundleId"] for a in helper.result("apps")["apps"]]
        check("apps lists the Wayland apps by desktop id", "org.gnome.Calculator" in ids and "org.gnome.TextEditor" in ids, ids)

        state = helper.result("state", app="Calculator", screenshot=True)
        check("state has the outline", find(state, name="7") is not None, outline(state))
        check("state explains why there is no screenshot",
              "screenshot" not in state and "permission" in state.get("screenshotError", ""), state.get("screenshotError"))
        buttons = {n.get("name"): n["id"] for n in state["nodes"]}
        act = helper.result("act", app="Calculator", actions=[
            *({"type": "click", "id": buttons[k]} for k in ("7", "+", "8", "=")),
            {"type": "wait_for", "text": "15", "timeout_ms": 3000},
        ])
        check("buttons press by id on Wayland", "error" not in act, act)

        raw = helper.result("act", app="Calculator", actions=[{"type": "click", "x": 10, "y": 10}])
        error = raw.get("error", {})
        check("a raw click is not_supported and points to element ids",
              error.get("code") == "not_supported" and "element ids" in error.get("message", ""), raw)

        editor = helper.result("state", app="Text Editor")
        area = find(editor, role="text area")
        check("the editor's text area is in the outline", area is not None, outline(editor))
        if area:
            typed = helper.result("act", app="Text Editor", actions=[{"type": "type", "id": area["id"], "text": "wayland text"}])
            check("type inserts text on Wayland", "wayland text" in json.dumps(typed.get("state", {})), typed)

        launched = helper.result("state", app="mousepad", timeout=40)
        check("state opens an app that is not running", launched.get("launched") is True and launched["app"]["bundleId"] == "org.xfce.mousepad", launched.get("app"))
        window = helper.result("act", app="Calculator", actions=[{"type": "window", "op": "move", "x": 10, "y": 10}])
        check("window moves are refused with a reason", window.get("error", {}).get("code") == "not_supported", window)
    finally:
        helper.close()
    print(f"{len(failures)} failed" if failures else "all passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
