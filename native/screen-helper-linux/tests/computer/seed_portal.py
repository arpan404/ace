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
       python3 seed_portal.py press-escape <app-id> <window-title>

press-escape stands in for the person at the machine pressing Escape once, through a
RemoteDesktop session it approves the same way: headless GNOME Shell starts in the overview,
which a person closes before using their apps.
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


def press_escape(app_id: str, title: str) -> None:
    token_file = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "ace-seed-escape-token")
    grant(token_file, app_id, title, "remote-desktop")
    try:
        with open(token_file) as file:
            token = file.read().strip()
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        sender = bus.get_unique_name()[1:].replace(".", "_")
        loop = GLib.MainLoop()

        def portal(interface: str, method: str, args: GLib.Variant) -> None:
            bus.call_sync(
                "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
                f"org.freedesktop.portal.{interface}", method, args, None,
                Gio.DBusCallFlags.NONE, 10000, None,
            )

        def ask(interface: str, method: str, build) -> dict:
            handle = "ace" + uuid.uuid4().hex[:8]
            path = f"/org/freedesktop/portal/desktop/request/{sender}/{handle}"
            answer: dict = {}

            def responded(_c, _s, _p, _i, _n, params):
                code, results = params.unpack()
                answer.update(results, code=code)
                loop.quit()

            watch = bus.signal_subscribe(
                "org.freedesktop.portal.Desktop", "org.freedesktop.portal.Request", "Response",
                path, None, Gio.DBusSignalFlags.NONE, responded,
            )
            portal(interface, method, build(handle))
            GLib.timeout_add_seconds(20, loop.quit)
            loop.run()
            bus.signal_unsubscribe(watch)
            if answer.get("code") != 0:
                raise RuntimeError(f"{method} was not approved: {answer}")
            return answer

        def options(handle: str, **extra) -> dict:
            return {"handle_token": GLib.Variant("s", handle), **extra}

        session = ask("RemoteDesktop", "CreateSession", lambda h: GLib.Variant(
            "(a{sv})", (options(h, session_handle_token=GLib.Variant("s", "s" + h)),)
        ))["session_handle"]
        ask("RemoteDesktop", "SelectDevices", lambda h: GLib.Variant("(oa{sv})", (session, options(
            h, types=GLib.Variant("u", KEYBOARD_AND_POINTER), persist_mode=GLib.Variant("u", 2),
            restore_token=GLib.Variant("s", token),
        ))))
        ask("ScreenCast", "SelectSources", lambda h: GLib.Variant("(oa{sv})", (session, options(
            h, types=GLib.Variant("u", WINDOW),
        ))))
        restored = ask("RemoteDesktop", "Start", lambda h: GLib.Variant("(osa{sv})", (session, "", options(h))))
        # A new virtual keyboard loses its first keys: a lone Shift wakes it, then Escape.
        for keysym, settle in ((0xFFE1, 0.4), (0xFF1B, 0.3)):
            for pressed in (1, 0):
                portal("RemoteDesktop", "NotifyKeyboardKeysym", GLib.Variant("(oa{sv}iu)", (session, {}, keysym, pressed)))
                time.sleep(0.05)
            time.sleep(settle)
        bus.call_sync(
            "org.freedesktop.portal.Desktop", session, "org.freedesktop.portal.Session", "Close",
            None, None, Gio.DBusCallFlags.NONE, 5000, None,
        )
        if restored.get("restore_token"):
            store("Delete", GLib.Variant("(ss)", ("remote-desktop", restored["restore_token"])))
    finally:
        # A restore already replaced the seeded grant; one left unused is removed here.
        try:
            revoke(token_file, "remote-desktop")
        except GLib.Error:
            pass
        os.remove(token_file)


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "press-escape":
        press_escape(sys.argv[2], sys.argv[3])
        sys.exit(0)
    table = "remote-desktop" if command.endswith("-remote-desktop") else "screencast"
    if command.startswith("grant"):
        grant(sys.argv[2], sys.argv[3], sys.argv[4], table)
    else:
        revoke(sys.argv[2], table)
