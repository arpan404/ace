"""Test-only: looks at, approves and cancels the portal's screen-sharing dialog through AT-SPI
directly, as a person would answer it (the helper refuses portals as targets, as it should).
Needs gir1.2-atspi-2.0.

GNOME's dialog is "Share Screen" with a Cancel button; its window list has no accessible action,
so it can't be approved here (seed_portal.py records a grant instead). KDE's chooser ("Share
screen with …", xdg-desktop-portal-kde) lists windows as buttons: pressing one shares it at once,
and its "Allow restoring on future sessions" box is ticked when the app asked for a persistent
grant. It has no accessible Cancel button, so cancelling closes its window through KWin, as the
person closing the dialog would.

Usage as a script: python3 portal_dialog.py approve <window title> | cancel | is-open
"""
import os
import sys
import tempfile
import time

import gi

gi.require_version("Atspi", "2.0")
gi.require_version("Gio", "2.0")
from gi.repository import Atspi, Gio, GLib  # noqa: E402  # pyright: ignore[reportAttributeAccessIssue]

# Window titles of the screen-sharing dialogs, lower case: GNOME's, then KDE's ScreenCast chooser
# and its RemoteDesktop chooser.
TITLES = ("share screen", "remote control requested")
KDE_RESTORE = "Allow restoring on future sessions"


def _dialog():
    desktop = Atspi.get_desktop(0)
    for index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(index)
        if not app or "portal" not in (app.get_name() or "").lower():
            continue
        for window_index in range(app.get_child_count()):
            window = app.get_child_at_index(window_index)
            name = (window.get_name() or "").lower() if window else ""
            if window and name.startswith(TITLES) and window.get_state_set().contains(Atspi.StateType.SHOWING):
                return window
    return None


def _find(node, role: str, name: str, depth: int = 0):
    if node is None or depth > 40:
        return None
    if node.get_role_name() == role and node.get_name() == name:
        return node
    for index in range(node.get_child_count()):
        found = _find(node.get_child_at_index(index), role, name, depth + 1)
        if found:
            return found
    return None


def _press(node, wanted: str = "Press") -> bool:
    for index in range(Atspi.Action.get_n_actions(node)):
        if Atspi.Action.get_action_name(node, index) == wanted:
            return bool(Atspi.Action.do_action(node, index))
    return False


def is_open(wait: float = 3.0) -> bool:
    deadline = time.time() + wait
    while True:
        if _dialog() is not None:
            return True
        if time.time() > deadline:
            return False
        time.sleep(0.3)


def _entry(node, title: str, depth: int = 0):
    """The chooser's button for a window whose title contains `title`."""
    if node is None or depth > 40:
        return None
    if node.get_role_name() == "button" and title in (node.get_name() or ""):
        return node
    for index in range(node.get_child_count()):
        found = _entry(node.get_child_at_index(index), title, depth + 1)
        if found:
            return found
    return None


def approve(window_title: str, remember: bool = True, wait: float = 10.0) -> bool:
    """Shares the window whose title contains `window_title`, as the person picking it in KDE's
    chooser would. `remember` leaves "Allow restoring on future sessions" ticked (the app asked
    for it)."""
    deadline = time.time() + wait
    while True:
        dialog = _dialog() if is_open(1.0) else None
        entry = _entry(dialog, window_title) if dialog else None
        if entry is not None:
            break
        if time.time() > deadline:
            return False
        time.sleep(0.3)
    restore = _find(dialog, "check box", KDE_RESTORE)
    if restore is not None and restore.get_state_set().contains(Atspi.StateType.CHECKED) != remember:
        _press(restore, "Toggle")
    return _press(entry)


def _close_with_kwin() -> bool:
    """Closes KDE's dialog window through a one-off KWin script, as the person closing it would."""
    script = """
for (const window of workspace.windowList()) {
    const caption = window.caption.toLowerCase();
    if (caption.startsWith("share screen") || caption.startsWith("remote control requested")) window.closeWindow();
}
"""
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as file:
        file.write(script)
    plugin = f"ace-close-portal-{os.getpid()}"
    try:
        def call(path: str, interface: str, method: str, args: GLib.Variant | None):
            return bus.call_sync("org.kde.KWin", path, interface, method, args, None, Gio.DBusCallFlags.NONE, 5000, None)

        number = call("/Scripting", "org.kde.kwin.Scripting", "loadScript", GLib.Variant("(ss)", (file.name, plugin))).unpack()[0]
        call(f"/Scripting/Script{number}", "org.kde.kwin.Script", "run", None)
        time.sleep(0.5)
        call("/Scripting", "org.kde.kwin.Scripting", "unloadScript", GLib.Variant("(s)", (plugin,)))
        return True
    except GLib.Error:
        return False
    finally:
        os.unlink(file.name)


def cancel() -> bool:
    """Presses Cancel (GNOME) or closes the dialog (KDE), as the person would."""
    if not is_open():
        return False
    button = _find(_dialog(), "button", "Cancel")
    if button is not None:
        return _press(button)
    if not _close_with_kwin():
        return False
    deadline = time.time() + 3
    while _dialog() is not None:
        if time.time() > deadline:
            return False
        time.sleep(0.2)
    return True


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "approve":
        ok = approve(sys.argv[2])
    elif command == "cancel":
        ok = cancel()
    elif command == "is-open":
        ok = is_open()
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(0 if ok else 1)
