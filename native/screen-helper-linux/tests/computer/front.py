"""Live check of typing in front (see run-front.sh) in a headless GNOME Shell Wayland session.

Chromium-based apps take no typed text through accessibility on Linux, so after an activate
step a batch types into them with the RemoteDesktop portal's keyboard, the app in front. The
app here is VS Code (Electron) and its chat input, found by its name. The person answers the
portal's dialog through portal_dialog.py: cancelling it, then allowing the keyboard.
"""
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(__file__))
import portal_dialog  # noqa: E402
from helper import Helper  # noqa: E402

BINARY = sys.argv[1]
TESTS = os.path.dirname(__file__)
APP = "com.microsoft.VSCode"
TITLE = "Visual Studio Code"
FIELD = "Chat Input"
TEXT = "hello from ace, typed in front: 1234567890! ABC xyz"
failures: list[str] = []


def check(name: str, condition: object, detail: object = "") -> None:
    condition = bool(condition)
    print(("ok   " if condition else "FAIL ") + name + ("" if condition else f"\n     {detail}"), flush=True)
    if not condition:
        failures.append(name)


def chat_field(helper: Helper) -> dict:
    """VS Code's chat input: a Chromium text field, there from the start."""
    for _ in range(20):
        state = helper.result("state", app=APP, timeout=60)
        field = next((n for n in state["nodes"] if n["role"] == "text field" and n.get("name", "").startswith(FIELD)), None)
        if field:
            return field
        time.sleep(1)
    raise AssertionError("VS Code shows no chat input")


def value(helper: Helper, node_id: int, app: str = APP):
    state = helper.result("state", app=app)
    return next((n.get("value") for n in state["nodes"] if n["id"] == node_id), None)


def code(reply: dict) -> str:
    return ((reply.get("result") or {}).get("error") or {}).get("code", "")


def message(reply: dict) -> str:
    return ((reply.get("result") or {}).get("error") or {}).get("message", "")


def type_in(helper: Helper, field: dict, text: str, activate: bool = True) -> dict:
    steps = [{"type": "activate"}] if activate else []
    steps.append({"type": "type", "id": field["id"], "text": text})
    return helper.call("act", app=APP, actions=steps, observe=False)


def clear(helper: Helper, field: dict) -> dict:
    return helper.call("act", app=APP, observe=False, actions=[
        {"type": "activate"}, {"type": "key", "key": "ctrl+a", "id": field["id"]},
        {"type": "key", "key": "BackSpace", "id": field["id"]},
    ])


def person_presses_escape() -> None:
    subprocess.run([sys.executable, os.path.join(TESTS, "seed_portal.py"), "press-escape", f"{APP}.desktop", TITLE],
                   check=False, timeout=30)


def asking(data: str) -> None:
    """The first time the person is asked; cancelling says so, allowing types, and the grant is
    remembered for the next helper."""
    helper = Helper(BINARY, "--data-dir", data)
    try:
        field = chat_field(helper)
        refused = type_in(helper, field, "hi", activate=False)
        check("typing into a Chromium field without activate is refused, saying how to type in front",
              code(refused) == "not_supported" and "activate step" in message(refused), refused)
        asked = type_in(helper, field, TEXT)
        check("the first time, the person is asked to allow the keyboard and nothing is typed",
              code(asked) == "keyboard_not_allowed" and "Allow Remote Interaction" in message(asked)
              and not value(helper, field["id"]), asked)
        check("the person cancels the dialog", portal_dialog.cancel())
        time.sleep(1)
        declined = type_in(helper, field, TEXT)
        check("a cancelled dialog is reported, saying to ask the person",
              code(declined) == "keyboard_not_allowed" and "not allowed" in message(declined), declined)
        asked = type_in(helper, field, TEXT)
        check("the person allows the keyboard in the dialog",
              code(asked) == "keyboard_not_allowed" and portal_dialog.allow_keyboard(), asked)
        typed = type_in(helper, field, TEXT)
        check("once allowed, the text is typed with the keyboard and arrives exactly",
              code(typed) == "" and value(helper, field["id"]) == TEXT, (typed, value(helper, field["id"])))
        clear(helper, field)
    finally:
        helper.close()
        if portal_dialog.is_open(0.5):
            portal_dialog.cancel()


def main() -> None:
    os.environ.setdefault("ELECTRON_OZONE_PLATFORM_HINT", "wayland")
    data = tempfile.mkdtemp(prefix="ace-front-")
    first = Helper(BINARY, "--data-dir", tempfile.mkdtemp(prefix="ace-front-open-"))
    try:
        chat_field(first)
    finally:
        first.close()
    # The person closes the shell's overview and lets the app be.
    person_presses_escape()
    time.sleep(2.5)
    asking(data)
    # A new helper can't tell the last one's keys from the person's: let them age.
    time.sleep(2)

    helper = Helper(BINARY, "--data-dir", data)
    try:
        field = chat_field(helper)
        started = time.time()
        typed = type_in(helper, field, TEXT)
        took = time.time() - started
        check("a later helper types with the remembered grant, asking nothing",
              code(typed) == "" and value(helper, field["id"]) == TEXT and not portal_dialog.is_open(0.5),
              (typed, value(helper, field["id"])))
        print(f"     {len(TEXT)} characters in {took:.2f} s, keyboard session included")

        cleared = clear(helper, field)
        check("keys accessibility can't press go through the keyboard too",
              code(cleared) == "" and not value(helper, field["id"]), (cleared, value(helper, field["id"])))

        # The person types somewhere: the agent never types over them.
        person_presses_escape()
        busy = type_in(helper, field, "over the person")
        check("while the person is at the keyboard, typing in front waits for them",
              code(busy) == "person_active" and not value(helper, field["id"]), busy)
        time.sleep(2)

        # Another app takes the focus, and the desktop keeps it in front: keys must never reach it.
        subprocess.Popen(["gnome-text-editor", "--standalone"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(4)
        editor = helper.result("state", app="org.gnome.TextEditor")
        area = next(n for n in editor["nodes"] if n["role"] == "text area")
        behind = type_in(helper, field, "never elsewhere")
        check("with another app in front, typing stops before any key and says why",
              code(behind) == "focus_changed" and "nothing was typed" in message(behind)
              and not value(helper, area["id"], "org.gnome.TextEditor") and not value(helper, field["id"]),
              (behind, value(helper, area["id"], "org.gnome.TextEditor")))
    finally:
        helper.close()
    print(f"{len(failures)} failed" if failures else "all passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
