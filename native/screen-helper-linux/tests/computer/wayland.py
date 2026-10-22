"""Live check of `--computer` in a GNOME Wayland session (see run-wayland.sh).

AT-SPI semantics work as on X11. Screenshots go through the ScreenCast portal: the first one
asks the person in the portal's dialog (approved here through the dialog's own accessibility
tree, as a person would click it), later ones restore silently from the saved token. Raw input
is unavailable and must say so in words the model can act on.
"""
import base64
import json
import os
import stat
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(__file__))
import portal_dialog  # noqa: E402
from helper import Helper, find, outline  # noqa: E402

BINARY = sys.argv[1]
DATA = tempfile.mkdtemp(prefix="ace-computer-data-")
TOKEN = os.path.join(DATA, "portal", "computer-org.gnome.Calculator.token")
PORTAL = "xdg-desktop-portal-gnome"
failures: list[str] = []


def check(name: str, condition: bool, detail: object = "") -> None:
    print(("ok   " if condition else "FAIL ") + name + ("" if condition else f"\n     {detail}"))
    if not condition:
        failures.append(name)


def dialog_open(_helper: Helper) -> bool:
    return portal_dialog.is_open()


def cancel_dialog(_helper: Helper) -> bool:
    """Presses Cancel in the portal dialog, as the person would (test-only, via AT-SPI)."""
    return portal_dialog.cancel()


def seed(*args: str) -> None:
    subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "seed_portal.py"), *args], check=True)


def token() -> str:
    with open(TOKEN) as file:
        return file.read()


def screenshot_of(state: dict) -> bytes:
    picture = state.get("screenshot")
    return base64.b64decode(picture["jpeg"]) if picture else b""


def screenshots(helper: Helper) -> Helper:
    started = time.time()
    first = helper.result("state", app="Calculator", screenshot=True)
    check("the first screenshot asks the person without waiting for them",
          "screenshot" not in first and "approve screen sharing for Calculator" in first.get("screenshotError", "")
          and time.time() - started < 6, (round(time.time() - started, 1), first.get("screenshotError")))
    check("the outline still comes with it", find(first, name="7") is not None)
    check("the portal's dialog is open for the person", dialog_open(helper))
    again = helper.result("state", app="Calculator", screenshot=True, outline=False)
    check("asking again while the dialog is up repeats the request",
          "approve screen sharing" in again.get("screenshotError", ""), again.get("screenshotError"))
    check("the person can decline in the dialog", cancel_dialog(helper))
    time.sleep(1)
    declined = helper.result("state", app="Calculator", screenshot=True, outline=False)
    check("a declined dialog is reported", "was not approved" in declined.get("screenshotError", ""), declined.get("screenshotError"))
    cancel_dialog(helper)  # declining is final for that request; close any dialog it reopened

    # The person approves (recorded as the dialog would record it; see seed_portal.py).
    # GNOME names windows by the shell's app id, the desktop file name.
    seed("grant", TOKEN, "org.gnome.Calculator.desktop", "Calculator")
    shot = helper.result("state", app="Calculator", screenshot=True, marks=True)
    jpeg = screenshot_of(shot)
    check("with a grant the screenshot arrives without a dialog", jpeg[:2] == b"\xff\xd8" and not dialog_open(helper), shot.get("screenshotError"))
    if jpeg:
        open("/tmp/ace-computer-wayland-calculator.jpg", "wb").write(jpeg)
        check("the picture is the window, scaled within limits", 0 < shot["screenshot"]["width"] <= 1568, shot["screenshot"])
    mode = stat.S_IMODE(os.stat(TOKEN).st_mode)
    # The portal may hand back a new token or the same one; either way it is kept privately.
    check("the restore token the portal returned is saved privately", mode == 0o600 and bool(token()), oct(mode))
    repeat = helper.result("state", app="Calculator", screenshot=True)
    check("later screenshots need no dialog", bool(screenshot_of(repeat)), repeat.get("screenshotError"))

    helper.close()
    helper = Helper(BINARY, "--data-dir", DATA)
    restored = helper.result("state", app="Calculator", screenshot=True)
    check("a restarted helper restores sharing from the token without asking",
          bool(screenshot_of(restored)) and not dialog_open(helper), restored.get("screenshotError"))

    seed("revoke", TOKEN)
    revoked = helper.result("state", app="Calculator", screenshot=True, outline=False)
    check("a revoked grant asks the person again", "approve screen sharing" in revoked.get("screenshotError", ""), revoked.get("screenshotError"))
    check("the dialog is open again", dialog_open(helper))
    cancel_dialog(helper)
    return helper


def main() -> None:
    for command in (["gnome-calculator"], ["gnome-text-editor", "--standalone"]):
        subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(6)
    helper = Helper(BINARY, "--data-dir", DATA)
    try:
        hello = helper.result("hello")
        check("hello reports accessibility and portal capture", hello["accessibility"] and hello["screenRecording"], hello)
        check("hello leaves out pointer-only steps", "drag" not in hello["capabilities"] and "click" in hello["capabilities"], hello)

        ids = [a["bundleId"] for a in helper.result("apps")["apps"]]
        check("apps lists the Wayland apps by desktop id", "org.gnome.Calculator" in ids and "org.gnome.TextEditor" in ids, ids)
        check("apps leaves out the desktop shell", not any("shell" in i.lower() or "portal" in i.lower() for i in ids), ids)
        shell = helper.call("resolve", app="gnome-shell")
        check("the shell is refused as a target", shell.get("error", {}).get("code") == "app_not_allowed", shell)
        portal = helper.call("state", app=PORTAL)
        check("portals are refused as targets", portal.get("error", {}).get("code") == "app_not_allowed", portal)

        state = helper.result("state", app="Calculator")
        check("state has the outline", find(state, name="7") is not None, outline(state))
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

        helper = screenshots(helper)

        launched = helper.result("state", app="mousepad", timeout=40)
        check("state opens an app that is not running", launched.get("launched") is True and launched["app"]["bundleId"] == "org.xfce.mousepad", launched.get("app"))
        window = helper.result("act", app="Calculator", actions=[{"type": "window", "op": "move", "x": 10, "y": 10}])
        check("window moves are refused with a reason", window.get("error", {}).get("code") == "not_supported", window)
    except Exception as error:  # report, don't hide the summary
        check("the Wayland check ran", False, repr(error))
    finally:
        helper.close()
    print(f"{len(failures)} failed" if failures else "all passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
