"""Test-only: stands in for the person approving screen sharing in GNOME's portal dialog.

GTK4 dialogs can't be answered through accessibility and a headless GNOME Shell gives a test
no reliable pointer target, so the test records the grant the dialog would record: a
"screencast" permission-store entry in GNOME's restore format (xdg-desktop-portal
xdp-session-persistence.c, xdg-desktop-portal-gnome screencast.c), and the matching restore
token in the helper's data dir. The helper itself never touches the permission store.

The live view (session mode) asks the RemoteDesktop portal instead, which keeps its grant in
the "remote-desktop" table: GNOME's restore data there also records the shared input devices
(xdg-desktop-portal-gnome remotedesktop.c, REMOTE_DESKTOP_RESTORE_VARIANT_TYPE).

Usage: python3 seed_portal.py grant <token-file> <app-id> <window-title>
       python3 seed_portal.py grant-remote-desktop <token-file> <app-id> <window-title>
       python3 seed_portal.py revoke <token-file>
       python3 seed_portal.py revoke-remote-desktop <token-file>
"""
import os
import sys
import time
import uuid

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402  # pyright: ignore[reportAttributeAccessIssue]

WINDOW = 2
KEYBOARD_AND_POINTER = 3


def store(method: str, args: GLib.Variant) -> None:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    bus.call_sync(
        "org.freedesktop.impl.portal.PermissionStore", "/org/freedesktop/impl/portal/PermissionStore",
        "org.freedesktop.impl.portal.PermissionStore", method, args, None, Gio.DBusCallFlags.NONE, 5000, None,
    )


def grant(token_file: str, app_id: str, title: str, table: str = "screencast") -> None:
    token = str(uuid.uuid4())
    now = int(time.time() * 1_000_000)
    window = GLib.Variant("(ss)", (app_id, title))
    if table == "remote-desktop":
        # Keyboard and pointer shared, clipboard not, then the one window stream.
        restore = GLib.Variant(
            "(xxuba(uuv))", (now, now, KEYBOARD_AND_POINTER, False, [(0, WINDOW, window)])
        )
    else:
        restore = GLib.Variant("(xxa(uuv))", (now, now, [(0, WINDOW, window)]))
    data = GLib.Variant("(suv)", ("GNOME", 1, restore))
    store("Set", GLib.Variant("(sbsa{sas}v)", (table, True, token, {"": ["yes"]}, data)))
    os.makedirs(os.path.dirname(token_file), mode=0o700, exist_ok=True)
    descriptor = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as file:
        file.write(token)


def revoke(token_file: str, table: str = "screencast") -> None:
    with open(token_file) as file:
        token = file.read().strip()
    store("Delete", GLib.Variant("(ss)", (table, token)))


if __name__ == "__main__":
    command = sys.argv[1]
    table = "remote-desktop" if command.endswith("-remote-desktop") else "screencast"
    if command.startswith("grant"):
        grant(sys.argv[2], sys.argv[3], sys.argv[4], table)
    else:
        revoke(sys.argv[2], table)
