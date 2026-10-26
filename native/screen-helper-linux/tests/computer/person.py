"""Live check of the person's side of `--computer` in a GNOME Wayland session (see run-person.sh).

While an agent acts in an app, GNOME Shell shows "ace is using <app>" with a Stop button. The
person points at the banner and clicks Stop (here with Mutter's remote-desktop pointer, at the
place the shell's accessibility tree gives, since the shell's buttons expose no accessible
action); the next action stops with `stopped_by_person`.
Looks carry the session state, and a locked screen gives no screenshot. The desktop is kept
awake: GNOME's inhibit services are not part of a headless shell, so stand-ins record what the
helper asks of them.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

import gi

gi.require_version("Atspi", "2.0")
gi.require_version("Gio", "2.0")
from gi.repository import Atspi, Gio, GLib  # noqa: E402  # pyright: ignore[reportAttributeAccessIssue]

sys.path.insert(0, os.path.dirname(__file__))
from helper import Helper, find  # noqa: E402

BINARY = sys.argv[1]
# Long enough for the person to reach Stop before the lease withdraws the notice.
LEASE_SECONDS = 8
failures: list[str] = []
calls: list[str] = []


def check(name: str, condition: bool, detail: object = "") -> None:
    print(("ok   " if condition else "FAIL ") + name + ("" if condition else f"\n     {detail}"))
    if not condition:
        failures.append(name)


STAND_INS = {
    "org.freedesktop.ScreenSaver": ("/org/freedesktop/ScreenSaver", """
<node><interface name="org.freedesktop.ScreenSaver">
  <method name="Inhibit"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="u" direction="out"/></method>
  <method name="UnInhibit"><arg type="u" direction="in"/></method>
</interface></node>"""),
    "org.gnome.SessionManager": ("/org/gnome/SessionManager", """
<node><interface name="org.gnome.SessionManager">
  <method name="Inhibit"><arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="u" direction="out"/></method>
  <method name="Uninhibit"><arg type="u" direction="in"/></method>
</interface></node>"""),
}


class Pointer:
    """The person's mouse: a Mutter remote-desktop session's pointer (test-only). Moves are
    relative from the top-left corner with pointer acceleration off, so they land exactly.
    (An absolute pointer needs a screen cast, and GNOME hides banners while casting.)"""

    def __init__(self) -> None:
        subprocess.run(["gsettings", "set", "org.gnome.desktop.peripherals.mouse", "accel-profile", "flat"], check=False)
        subprocess.run(["gsettings", "set", "org.gnome.desktop.peripherals.mouse", "speed", "0"], check=False)
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.session = self.call("/org/gnome/Mutter/RemoteDesktop", "org.gnome.Mutter.RemoteDesktop", "CreateSession").unpack()[0]
        self.call(self.session, "org.gnome.Mutter.RemoteDesktop.Session", "Start")

    def call(self, path: str, iface: str, method: str, args=None):
        return self.bus.call_sync("org.gnome.Mutter.RemoteDesktop", path, iface, method, args, None,
                                  Gio.DBusCallFlags.NONE, 5000, None)

    def move_to(self, x: float, y: float) -> None:
        session = "org.gnome.Mutter.RemoteDesktop.Session"
        self.call(self.session, session, "NotifyPointerMotionRelative", GLib.Variant("(dd)", (-10_000.0, -10_000.0)))
        time.sleep(0.1)
        # Small steps, as a hand moves: no single jump is large enough to be accelerated.
        steps = max(1, int(max(x, y) // 20))
        for _ in range(steps):
            self.call(self.session, session, "NotifyPointerMotionRelative", GLib.Variant("(dd)", (x / steps, y / steps)))
        time.sleep(0.4)

    def click(self) -> None:
        for pressed in (True, False):
            self.call(self.session, "org.gnome.Mutter.RemoteDesktop.Session", "NotifyPointerButton",
                      GLib.Variant("(ib)", (0x110, pressed)))
            time.sleep(0.05)


def on_screen(role: str, name: str):
    """The screen box of the shell's showing element `name`, or None."""
    for found_role, found_name, node in shell_nodes():
        if found_role == role and found_name == name and node.get_state_set().contains(Atspi.StateType.SHOWING):
            box = node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
            if box.width > 0:
                return box
    return None


def click_stop(pointer: Pointer, app: str) -> bool:
    """Points at the banner, which shows its buttons, and clicks Stop."""
    found: dict = {}
    if not wait_until(lambda: found.update(banner=on_screen("label", f"ace is using {app}")) or found["banner"], 5):
        return False
    banner = found["banner"]
    pointer.move_to(banner.x + banner.width / 2, banner.y + banner.height / 2)
    if not wait_until(lambda: found.update(button=on_screen("button", "Stop")) or found["button"], 3):
        return False
    button = found["button"]
    pointer.move_to(button.x + button.width / 2, button.y + button.height / 2)
    pointer.click()
    return True


def serve_stand_ins() -> None:
    """GNOME's inhibit services, recording each call as `<service> <method> <args>`."""
    ready = threading.Event()

    def run() -> None:
        context = GLib.MainContext.new()
        context.push_thread_default()
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        cookies = iter(range(100, 10_000))
        for name, (path, xml) in STAND_INS.items():
            info = Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0]

            def call(_conn, _sender, _path, _iface, method, params, invocation, name=name):
                calls.append(f"{name.rsplit('.', 1)[-1]} {method} {params.unpack()}")
                if method in ("Inhibit",):
                    invocation.return_value(GLib.Variant("(u)", (next(cookies),)))
                else:
                    invocation.return_value(None)

            bus.register_object(path, info, call, None, None)
            Gio.bus_own_name_on_connection(bus, name, Gio.BusNameOwnerFlags.NONE, None, None)
        ready.set()
        GLib.MainLoop(context).run()

    threading.Thread(target=run, daemon=True).start()
    ready.wait(5)
    time.sleep(0.5)


def shell_nodes() -> list:
    """GNOME Shell's accessible elements, as (role, name, node)."""
    desktop = Atspi.get_desktop(0)
    found = []

    def walk(node, depth: int) -> None:
        if node is None or depth > 25:
            return
        try:
            found.append((node.get_role_name(), node.get_name() or "", node))
            count = node.get_child_count()
        except GLib.Error:
            return
        for index in range(min(count, 200)):
            try:
                child = node.get_child_at_index(index)
            except GLib.Error:  # the shell removed it meanwhile
                continue
            walk(child, depth + 1)

    for index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(index)
        if app is not None and (app.get_name() or "").lower() == "gnome-shell":
            walk(app, 0)
    return found


def notice_shown(app: str) -> bool:
    return any(name == f"ace is using {app}" for _, name, _ in shell_nodes())


def wait_until(condition, seconds: float) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        if condition():
            return True
        time.sleep(0.2)
    return condition()


def press(helper: Helper, key: str) -> dict:
    state = helper.result("state", app="calculator")
    button = find(state, name=key)
    return helper.result("act", app="calculator", actions=[{"type": "click", "id": button["id"]}])


def stop(helper: Helper) -> None:
    # The person's mouse is ready before the agent acts: the banner shows for a few seconds.
    pointer = Pointer()
    acted = press(helper, "7")
    check("an act runs and GNOME Shell tells the person which app the agent uses",
          "error" not in acted and wait_until(lambda: notice_shown("Calculator"), 5), acted)
    check("the person clicks Stop on the banner", click_stop(pointer, "Calculator"))
    time.sleep(1)
    stopped = press(helper, "8")
    check("the next action stops, telling the agent to ask the person", stopped.get("error", {}).get("code") == "stopped_by_person", stopped)
    check("the notice goes once the agent stopped", wait_until(lambda: not notice_shown("Calculator"), 5))
    again = press(helper, "9")
    check("Stop is used up: a later request runs and shows the notice again",
          "error" not in again and wait_until(lambda: notice_shown("Calculator"), 5), again)
    # Stop pressed while the agent is between calls, and nothing acts again before the lease
    # ends: it lapses with the lease and never stops a later, unrelated request.
    check("the person clicks Stop between calls", click_stop(pointer, "Calculator"))
    time.sleep(LEASE_SECONDS + 1.5)
    later = press(helper, "4")
    check("a Stop nobody acted on lapses with the lease", "error" not in later, later)


def awake(helper: Helper) -> None:
    # Start from no lease: the last part's lease runs out first.
    time.sleep(LEASE_SECONDS + 1.5)
    calls.clear()
    press(helper, "1")
    held = list(calls)
    check("a batch keeps the screen on and holds off automatic suspend",
          any(c.startswith("ScreenSaver Inhibit") for c in held) and any(c.startswith("SessionManager Inhibit") and c.endswith(", 4)") for c in held), held)
    check("after the batch the screen may sleep again, suspend stays held off",
          any(c.startswith("ScreenSaver UnInhibit") for c in held) and not any(c.startswith("SessionManager Uninhibit") for c in held), held)
    time.sleep(LEASE_SECONDS + 1.5)
    check("the lease ends without another call, and so does the notice",
          any(c.startswith("SessionManager Uninhibit") for c in calls) and not notice_shown("Calculator"), calls)


def lock(helper: Helper) -> None:
    look = helper.result("state", app="calculator", outline=False)
    check("a look carries the session state", look.get("sessionState") == "active" and look.get("screenLocked") is False, look)
    # A headless shell has no lock screen, so the person locks the way Omarchy does: a
    # session-lock client (hyprlock) runs. A stand-in program carries its name.
    stand_in = os.path.join(tempfile.mkdtemp(prefix="ace-lock-"), "hyprlock")
    shutil.copy("/bin/sleep", stand_in)
    locker = subprocess.Popen([stand_in, "60"])
    try:
        time.sleep(0.5)
        look = helper.result("state", app="calculator", screenshot=True)
        locked(helper, look)
    finally:
        locker.kill()
    look = helper.result("state", app="calculator", outline=False)
    check("unlocked again, looks say so", look.get("screenLocked") is False, look)


def locked(helper: Helper, look: dict) -> None:
    check("while locked a look says so and takes no screenshot",
          look.get("screenLocked") is True and "screenshot" not in look and "locked" in look.get("screenshotError", ""), look)
    acted = press(helper, "2")
    check("accessibility actions still work while locked", "error" not in acted, acted)


def main() -> None:
    serve_stand_ins()
    subprocess.Popen(["gnome-calculator"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(5)
    helper = Helper(BINARY, "--lease-seconds", str(LEASE_SECONDS))
    try:
        for part in (stop, awake, lock):
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
