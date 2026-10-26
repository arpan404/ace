"""Live check of `--computer` on KDE Plasma 6, Wayland or X11 (see run-kde.sh).

Qt apps expose their trees once the helper turns accessibility on; KCalc, KWrite and Kate are
driven by element id and menu path as an agent would. Plasma's own pieces (the shell, KRunner,
KWin, the portal) are never targets. On Wayland, screenshots go through KDE's ScreenCast chooser,
which this test answers through the chooser's own accessibility tree, as the person would click
it (portal_dialog.py); raw input and window management are refused. On X11 the helper captures
windows itself, manages them through EWMH and sends raw keys to the front window.
"""
import base64
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
SESSION = os.environ.get("XDG_SESSION_TYPE", "")
DATA = tempfile.mkdtemp(prefix="ace-computer-kde-")
TOKEN = os.path.join(DATA, "portal", "computer-org.kde.kcalc.token")
NOTE = os.path.join(DATA, "kde-note.txt")
failures: list[str] = []


def check(name: str, condition: bool, detail: object = "") -> None:
    print(("ok   " if condition else "FAIL ") + name + ("" if condition else f"\n     {detail}"))
    if not condition:
        failures.append(name)


def picture(state: dict) -> bytes:
    shot = state.get("screenshot")
    return base64.b64decode(shot["jpeg"]) if shot else b""


def ids_by_name(state: dict) -> dict:
    return {node.get("name"): node["id"] for node in state.get("nodes", [])}


def area_value(state: dict) -> str:
    area = find(state.get("state", state), role="text area")
    return (area or {}).get("value", "")


def desktop(helper: Helper) -> None:
    hello = helper.result("hello")
    check("hello reports accessibility and capture", hello["accessibility"] and hello["screenRecording"], hello)
    listed = {app["bundleId"]: app for app in helper.result("apps")["apps"]}
    for app_id, name in (("org.kde.kcalc", "KCalc"), ("org.kde.kwrite", "KWrite"), ("org.kde.kate", "Kate")):
        check(f"apps lists {name} by its desktop id", listed.get(app_id, {}).get("name") == name, sorted(listed))
    hidden = [app for app in listed if any(part in app.lower() for part in ("plasmashell", "krunner", "kded", "kwin", "portal"))]
    check("apps leaves out Plasma's shell, KRunner, kded, KWin and the portal", not hidden, hidden)
    for component in ("plasmashell", "krunner", "org.kde.krunner", "kded6", "kwin_wayland", "kwin_x11", "xdg-desktop-portal-kde"):
        refused = helper.call("resolve", app=component)
        check(f"{component} is refused as a target", refused.get("error", {}).get("code") in ("app_not_allowed", "app_not_found"), refused)
    check("KRunner is refused as part of the desktop, not missing",
          helper.call("state", app="krunner").get("error", {}).get("code") == "app_not_allowed")


def calculator(helper: Helper) -> None:
    state = helper.result("state", app="kcalc")
    keys = ids_by_name(state)
    check("KCalc's buttons are in the outline by name", all(k in keys for k in ("Seven", "Multiply", "Six", "Equals")), outline(state))
    acted = helper.result("act", app="org.kde.kcalc", actions=[
        *({"type": "click", "id": keys[k]} for k in ("Seven", "Multiply", "Six", "Equals")),
        {"type": "wait_for", "text": "42", "timeout_ms": 4000},
    ])
    check("KCalc's buttons press by id in the background and the display reads 42", "error" not in acted, acted)
    check("KCalc's menu bar is listed", acted.get("state", {}).get("menuBar", [])[:2] == ["File", "Edit"], acted.get("state", {}).get("menuBar"))


def editor(helper: Helper) -> None:
    state = helper.result("state", app="KWrite")
    area = find(state, role="text area")
    check("KWrite's editor is a text area holding the file's text", area is not None and area.get("value") == "hello", outline(state))
    if area is None:
        return
    focused = state.get("focused", {})
    check("the editor, not the status-bar buttons it lends focus to, is the focused element",
          focused.get("id") == area["id"], focused)
    flagged = [node["id"] for node in state["nodes"] if "focused" in node.get("flags", [])]
    check("only one element is marked focused", flagged == [area["id"]], flagged)
    typed = helper.result("act", app="KWrite", actions=[
        {"type": "select_text", "id": area["id"], "text": "hello"},
        {"type": "type", "id": area["id"], "text": "typed by ace"},
    ])
    check("typing by id replaces the selected text", area_value(typed) == "typed by ace", typed)
    focus_typed = helper.result("act", app="KWrite", actions=[{"type": "type", "text": "!"}])
    check("typing without an id goes to the focused editor", "!" in area_value(focus_typed), focus_typed)
    edited = helper.result("act", app="KWrite", actions=[
        {"type": "key", "key": "cmd+a", "id": area["id"]},
        {"type": "key", "key": "Backspace", "id": area["id"]},
        {"type": "paste", "id": area["id"], "text": "pasted"},
    ])
    check("select all, Backspace and paste work in the background", area_value(edited) == "pasted", edited)


def menus(helper: Helper) -> None:
    chose = helper.result("act", app="Kate", actions=[{"type": "menu", "path": ["File", "New"]}])
    check("a Qt menu item is chosen by path", "error" not in chose and "chose File > New" in chose.get("done", []), chose)
    about = helper.result("act", app="Kate", actions=[{"type": "menu", "path": ["Help", "About Kate"]}])
    titles = [window["title"] for window in about.get("state", {}).get("windows", [])]
    check("a menu that opens a dialog lists the dialog among Kate's windows", "About Kate" in titles, titles)
    dialog = helper.result("state", app="Kate", window="About Kate")
    close = find(dialog, role="button", name="Close")
    check("the dialog is looked at by its title", close is not None, outline(dialog))
    if close:
        closed = helper.result("act", app="Kate", window="About Kate", actions=[{"type": "click", "id": close["id"]}])
        check("its Close button closes it", "error" not in closed, closed)


def wayland_screenshots(helper: Helper) -> Helper:
    started = time.time()
    first = helper.result("state", app="kcalc", screenshot=True)
    check("the first screenshot opens KDE's chooser without waiting for the person",
          not picture(first) and "approve screen sharing for KCalc" in first.get("screenshotError", "") and time.time() - started < 6,
          first.get("screenshotError"))
    check("the outline still comes with it", find(first, name="Seven") is not None)
    check("the chooser is open for the person", portal_dialog.is_open())
    check("the person can close the chooser", portal_dialog.cancel())
    time.sleep(0.5)
    declined = helper.result("state", app="kcalc", screenshot=True, outline=False)
    check("a closed chooser is reported as not approved", "was not approved" in declined.get("screenshotError", ""), declined.get("screenshotError"))
    again = helper.result("state", app="kcalc", screenshot=True, outline=False)
    check("asking again opens the chooser again", "approve screen sharing" in again.get("screenshotError", "") and portal_dialog.is_open(), again.get("screenshotError"))
    check("the person picks KCalc in the chooser, remembering it", portal_dialog.approve("KCalc"))
    time.sleep(0.5)
    shot = helper.result("state", app="kcalc", screenshot=True, marks=True)
    jpeg = picture(shot)
    check("after approval the screenshot is KCalc's window", jpeg[:2] == b"\xff\xd8" and 200 < shot["screenshot"]["width"] < 1000, shot.get("screenshotError") or shot.get("screenshot", {}).get("width"))
    if jpeg:
        open("/tmp/ace-computer-kde-kcalc.jpg", "wb").write(jpeg)
    check("KDE's restore token is kept privately", os.path.exists(TOKEN) and stat.S_IMODE(os.stat(TOKEN).st_mode) == 0o600)
    helper.close()
    helper = Helper(BINARY, "--data-dir", DATA)
    restored = helper.result("state", app="kcalc", screenshot=True, outline=False)
    check("a restarted helper restores sharing without asking", bool(picture(restored)) and not portal_dialog.is_open(1), restored.get("screenshotError"))
    subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "seed_portal.py"), "revoke", TOKEN], check=True)
    revoked = helper.result("state", app="kcalc", screenshot=True, outline=False)
    check("a revoked grant asks the person again", "approve screen sharing" in revoked.get("screenshotError", ""), revoked.get("screenshotError"))
    portal_dialog.cancel()
    return helper


def wayland_limits(helper: Helper) -> None:
    raw = helper.result("act", app="kcalc", actions=[{"type": "key", "key": "Escape"}])
    check("a raw key is refused and points to element ids", raw.get("error", {}).get("code") == "not_supported" and "element ids" in raw["error"]["message"], raw)
    moved = helper.result("act", app="kcalc", actions=[{"type": "window", "op": "move", "x": 10, "y": 10}])
    check("window moves are refused with a reason", moved.get("error", {}).get("code") == "not_supported", moved)


def x11(helper: Helper) -> None:
    shot = helper.result("state", app="kcalc", screenshot=True, marks=True, outline=False)
    check("X11 captures KCalc's window directly", picture(shot)[:2] == b"\xff\xd8", shot.get("screenshotError"))
    state = helper.result("state", app="kcalc")
    keys = ids_by_name(state)
    raw = helper.result("act", app="kcalc", actions=[{"type": "key", "key": "Escape"}])
    check("a raw key for a background window asks for activate", raw.get("error", {}).get("code") == "not_on_screen", raw)
    typed = helper.result("act", app="kcalc", actions=[
        {"type": "click", "id": keys["All clear"]},
        {"type": "activate"},
        {"type": "key", "key": "9"},
        {"type": "wait_for", "text": "9", "timeout_ms": 3000},
    ])
    check("after activate, raw keys reach KCalc through KWin", "error" not in typed, typed)
    for op in ("minimize", "restore", "zoom", "restore"):
        done = helper.result("act", app="kcalc", actions=[{"type": "window", "op": op}])
        check(f"window {op} works through KWin on X11", "error" not in done, done)
    moved = helper.result("act", app="kcalc", actions=[{"type": "window", "op": "move", "x": 40, "y": 60}])
    check("window move works through KWin on X11", "error" not in moved, moved)


def main() -> None:
    with open(NOTE, "w") as file:
        file.write("hello\n")
    helper = Helper(BINARY, "--data-dir", DATA)
    try:
        helper.result("hello")  # turns accessibility on, so the apps expose their trees
        # KWrite starts last, so it is the active window and its editor has the focus.
        for command in (["kate", "-n"], ["kcalc"], ["kwrite", NOTE]):
            subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(2)
        time.sleep(5)
        desktop(helper)
        calculator(helper)
        editor(helper)
        menus(helper)
        if SESSION == "wayland":
            wayland_limits(helper)
            helper = wayland_screenshots(helper)
        else:
            x11(helper)
    except Exception as error:  # report, don't hide the summary
        check("the KDE check ran", False, repr(error))
    finally:
        helper.close()
    print(f"{len(failures)} failed" if failures else "all passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
