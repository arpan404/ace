"""Check of `--computer` on a real Omarchy 4 desktop: Hyprland with Omarchy's Quickshell shell,
which draws the bar, notifications and lock screen itself.

Run it from a terminal in the person's session: `python3 omarchy.py <helper binary>`. It opens
Nautilus and Chromium, acts in Nautilus, and clicks the "ace is using" notice the way a click
does (`omarchy-shell notifications invokeLast`). The lock screen is not exercised: only the
person's password unlocks it.
"""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from helper import Helper, find  # noqa: E402

failures: list[str] = []
SHELL_PARTS = {"quickshell", "qs", "omarchy-shell", "elephant", "walker", "hyprsunset", "swayosd-server"}


def check(name: str, condition: object, detail: object = "") -> None:
    condition = bool(condition)
    print(("ok   " if condition else "FAIL ") + name + ("" if condition else f"\n     {detail}"), flush=True)
    if not condition:
        failures.append(name)


def note(text: str) -> None:
    print("     " + text, flush=True)


def click_notice() -> str:
    clicked = subprocess.run(["omarchy-shell", "notifications", "invokeLast"], capture_output=True, text=True)
    return clicked.stdout.strip() or clicked.stderr.strip()


def person(helper: Helper) -> None:
    facts = helper.result("hello").get("person", {})
    check("the person's input comes from the compositor and notices can show",
          facts.get("idle") == "wayland" and facts.get("notifications") is True, facts)
    apps = helper.result("apps")["apps"]
    listed = {(app.get("bundleId") or "").lower() for app in apps}
    check("Omarchy's own shell is never listed as an app", not (listed & SHELL_PARTS), sorted(listed))
    note("apps: " + ", ".join(sorted(listed)))


def nautilus(helper: Helper) -> None:
    look = helper.call("state", app="org.gnome.Nautilus", timeout=60)
    check("Nautilus opens and shows its controls", look.get("ok") and len(look["result"]["nodes"]) > 10, look)
    if not look.get("ok"):
        return
    first = look["result"]
    check("a look says the session is active and unlocked",
          first.get("sessionState") == "active" and first.get("screenLocked") is False, first)
    again = helper.result("state", app="org.gnome.Nautilus")
    note(f"look {first.get('elapsedMs')} ms, repeat {again.get('elapsedMs')} ms, {len(again['nodes'])} elements")
    home = find(again, name="Home") or next((n for n in again["nodes"] if n["role"] == "button" and n.get("actions")), None)
    if home is None:
        check("Nautilus has something to click", False, again["nodes"][:20])
        return

    def press() -> dict:
        return helper.call("act", app="org.gnome.Nautilus", actions=[{"type": "click", "id": home["id"]}])

    acted = press()
    check(f"an act runs ({home['role']} {home.get('name')!r})", acted.get("ok"), acted)
    time.sleep(1)
    clicked = click_notice()
    check("the person clicks the \"ace is using\" notice", clicked == "ok", clicked)
    time.sleep(1)
    stopped = press()
    check("the next action stops, telling the agent to ask the person",
          (stopped.get("error") or {}).get("code") == "stopped_by_person", stopped)
    later = press()
    check("Stop is used up: a later request runs", later.get("ok"), later)
    shot = helper.result("state", app="org.gnome.Nautilus", screenshot=True, outline=False)
    note("screenshot: " + (f"{shot['screenshot']['width']}x{shot['screenshot']['height']}" if shot.get("screenshot")
                           else str(shot.get("screenshotError"))))


def chromium(helper: Helper) -> None:
    look = helper.call("state", app="chromium", timeout=60)
    result = look.get("result") or {}
    check("Chromium opened by ace shows its pages and controls",
          look.get("ok") and len(result.get("nodes", [])) > 8 and not result.get("accessibilityNote"), look)
    if look.get("ok"):
        roles = sorted({n["role"] for n in result["nodes"]})
        note(f"chromium look {result.get('elapsedMs')} ms, {len(result['nodes'])} elements; roles: {', '.join(roles)}")


def main() -> None:
    helper = Helper(sys.argv[1])
    try:
        for part in (person, nautilus, chromium):
            try:
                part(helper)
            except Exception as error:  # a broken part must not hide the others
                check(f"{part.__name__} ran", False, repr(error))
    finally:
        helper.close()
        errors = []
        while not helper.stderr.empty():
            errors.append(helper.stderr.get())
        if errors:
            note("helper stderr:\n" + "".join(errors[-30:]))
    print(f"{len(failures)} failed" if failures else "all passed", flush=True)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
