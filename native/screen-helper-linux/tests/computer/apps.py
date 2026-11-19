"""Live check of `--computer` with everyday apps in a GNOME Wayland session (see run-apps.sh).

What Wayland refuses as raw input is done through accessibility: an x,y click is the element
under that screenshot pixel, a shortcut is the menu item that lists it, copy and paste use the
text's own clipboard calls. LibreOffice's modules share one process and are told apart by their
windows' titles. Chromium-based apps are opened with accessibility on. Apps that are not
installed are skipped and say so.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(__file__))
from helper import Helper, find  # noqa: E402

BINARY = sys.argv[1]
TESTS = os.path.dirname(__file__)
DATA = tempfile.mkdtemp(prefix="ace-apps-data-")
failures: list[str] = []


def check(name: str, condition: bool, detail: object = "") -> None:
    print(("ok   " if condition else "FAIL ") + name + ("" if condition else f"\n     {detail}"))
    if not condition:
        failures.append(name)


def installed(command: str) -> bool:
    return shutil.which(command) is not None


def values(state: dict, *roles: str) -> list:
    return [node.get("value") for node in state.get("nodes", []) if node["role"] in roles]


def xy_click(helper: Helper) -> None:
    subprocess.run([sys.executable, os.path.join(TESTS, "seed_portal.py"), "grant",
                    os.path.join(DATA, "portal", "computer-org.gnome.Calculator.token"),
                    "org.gnome.Calculator.desktop", "Calculator"], check=True)
    look = helper.result("state", app="calculator", screenshot=True)
    shot = look.get("screenshot")
    check("Calculator's screenshot arrives", shot is not None, look.get("screenshotError"))
    if not shot:
        return
    # The lower half of Calculator is its keypad.
    pressed = helper.result("act", app="calculator",
                            actions=[{"type": "click", "x": shot["width"] * 0.5, "y": shot["height"] * 0.85}])
    done = (pressed.get("done") or [""])[0]
    check("an x,y click presses the button under that screenshot pixel",
          "error" not in pressed and done.startswith("pressed") and "button" in done and done.endswith("(the element at the point)"), pressed)
    gap = helper.result("act", app="calculator", actions=[{"type": "click", "x": 2, "y": 2}])
    check("an x,y click with no control near it is refused, never pressing the window",
          gap.get("error", {}).get("code") == "not_clickable", gap)


def shortcuts(helper: Helper) -> None:
    look = helper.result("state", app="mousepad")
    area = find(look, role="text area") or find(look, role="text field")
    acted = helper.result("act", app="mousepad", actions=[
        {"type": "type", "text": "indent me", "id": area["id"]},
        {"type": "key", "key": "ctrl+i"},
    ])
    check("a shortcut presses the menu item that lists it, in the background",
          "error" not in acted and "Increase Indent" in acted["done"][1], acted)
    unknown = helper.result("act", app="mousepad", actions=[{"type": "key", "key": "ctrl+alt+F12"}])
    check("a shortcut no menu lists is refused with what works instead",
          unknown.get("error", {}).get("code") == "not_supported" and "element ids" in unknown["error"]["message"], unknown)


def clipboard(helper: Helper) -> None:
    look = helper.result("state", app="org.gnome.TextEditor")
    area = find(look, role="text area")
    acted = helper.result("act", app="org.gnome.TextEditor", actions=[
        {"type": "type", "text": "copy me", "id": area["id"]},
        {"type": "select_text", "id": area["id"], "text": "copy"},
        {"type": "key", "key": "ctrl+c", "id": area["id"]},
        {"type": "key", "key": "End", "id": area["id"]},
        {"type": "key", "key": "ctrl+v", "id": area["id"]},
    ])
    check("copy and paste in text go through the text's own clipboard calls",
          "error" not in acted and "copy mecopy" in values(acted.get("state", {}), "text area"), acted)


def office(helper: Helper) -> None:
    if not installed("libreoffice"):
        print("skip LibreOffice: not installed")
        return
    writer = helper.call("state", app="LibreOffice Writer", timeout=60)
    check("LibreOffice Writer opens and is named by its module", writer.get("ok") and writer["result"]["app"]["bundleId"] == "libreoffice-writer", writer)
    if not writer.get("ok"):
        return
    document = next((n for n in writer["result"]["nodes"] if n["role"] == "document text"), None)
    check("the document is not marked disabled", document is not None and "disabled" not in document.get("flags", []), document)
    acted = helper.result("act", app="LibreOffice Writer", actions=[
        {"type": "type", "id": document["id"], "text": "Hello from ace"},
        {"type": "key", "key": "ctrl+a", "id": document["id"]},
        {"type": "key", "key": "ctrl+b"},
    ])
    check("typing into the document reaches the paragraph with the caret, and ctrl+b presses Bold",
          "error" not in acted and "Bold" in acted["done"][2], acted)
    calc = helper.call("state", app="LibreOffice Calc", timeout=60)
    check("Calc opens in the same process and is its own app", calc.get("ok") and calc["result"]["app"]["bundleId"] == "libreoffice-calc"
          and calc["result"]["window"]["title"].endswith("LibreOffice Calc"), calc)
    back = helper.result("state", app="LibreOffice Writer", outline=False)
    check("asking for Writer again picks Writer's window", back["window"]["title"].endswith("LibreOffice Writer"), back.get("window"))
    listed = {app["bundleId"] for app in helper.result("apps")["apps"]}
    check("the app list shows each open module", {"libreoffice-writer", "libreoffice-calc"} <= listed, listed)


def chromium(helper: Helper) -> None:
    if not os.environ.get("ACE_TEST_CHROMIUM_APP"):
        print("skip Chromium: set ACE_TEST_CHROMIUM_APP to the desktop id of a Chromium-based app")
        return
    app = os.environ["ACE_TEST_CHROMIUM_APP"]
    look = helper.call("state", app=app, timeout=60)
    check("a Chromium-based app opened by ace shows its pages and controls",
          look.get("ok") and len(look["result"]["nodes"]) > 8 and not look["result"].get("accessibilityNote"), look)
    if not look.get("ok"):
        return
    field = next((n for n in look["result"]["nodes"] if n["role"] == "text field"), None)
    if field:
        typed = helper.result("act", app=app, actions=[{"type": "type", "id": field["id"], "text": "hi"}])
        check("typing into a Chromium field is refused with the reason", typed.get("error", {}).get("code") == "not_supported"
              and "Chromium" in typed["error"]["message"], typed)


def main() -> None:
    for command in (["gnome-calculator"], ["mousepad"], ["gnome-text-editor", "--standalone"]):
        subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(5)
    # The person closes the shell's overview before using their apps.
    subprocess.run([sys.executable, os.path.join(TESTS, "seed_portal.py"), "press-escape", "org.xfce.mousepad.desktop", "Untitled 1 - Mousepad"], check=False, timeout=30)
    helper = Helper(BINARY, "--data-dir", DATA)
    try:
        for part in (xy_click, shortcuts, clipboard, office, chromium):
            try:
                part(helper)
            except Exception as error:  # a broken part must not hide the others
                check(f"{part.__name__} ran", False, repr(error))
    finally:
        helper.close()
    print(f"{len(failures)} failed" if failures else "all passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
