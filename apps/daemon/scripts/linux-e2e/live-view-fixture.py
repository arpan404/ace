"""Test-only GTK 4 app for the Linux live-view suite: a 400x300 window without decorations,
so a point in its picture is the same point in the window. It writes what reaches it, one JSON
line each, to $ACE_E2E_FIXTURE_LOG: {"click": [x, y, button]}, {"scroll": [dx, dy]} and
{"key": name}, and {"active": bool} as it gains and loses focus. Its desktop id is dev.ace.LiveViewFixture (the runner installs the .desktop).
"""
import json
import os
import sys

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gtk  # noqa: E402  # pyright: ignore[reportAttributeAccessIssue]

log = open(os.environ["ACE_E2E_FIXTURE_LOG"], "a", buffering=1)


def record(entry):
    log.write(json.dumps(entry) + "\n")


def activate(app):
    # Activated again (as a launcher or ace does), the one window comes forward.
    if app.get_active_window():
        app.get_active_window().present()
        return
    window = Gtk.ApplicationWindow(application=app, title="Live view fixture")
    window.set_decorated(False)
    window.set_default_size(400, 300)
    window.set_resizable(False)
    area = Gtk.DrawingArea()
    area.set_content_width(400)
    area.set_content_height(300)
    area.set_focusable(True)
    window.set_child(area)
    click = Gtk.GestureClick(button=0)
    click.connect(
        "pressed",
        lambda gesture, _n, x, y: record({"click": [round(x), round(y), gesture.get_current_button()]}),
    )
    area.add_controller(click)
    scroll = Gtk.EventControllerScroll(flags=Gtk.EventControllerScrollFlags.BOTH_AXES)
    scroll.connect("scroll", lambda _c, dx, dy: record({"scroll": [dx, dy]}) or True)
    area.add_controller(scroll)
    keys = Gtk.EventControllerKey()
    keys.connect("key-pressed", lambda _c, keyval, _code, _state: record({"key": Gtk.accelerator_name(keyval, 0)}) or False)
    window.add_controller(keys)
    window.connect("notify::is-active", lambda shown, _: record({"active": shown.is_active()}))
    window.present()
    record({"ready": True})


app = Gtk.Application(application_id="dev.ace.LiveViewFixture")
app.connect("activate", activate)
sys.exit(app.run([]))
