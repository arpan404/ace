"""Test-only GTK 4 window that grows on SIGUSR1: each signal makes it 96 px wider and 64 px
taller, so the desktop's stream of it changes size and PipeWire negotiates its buffers again.
It shows a fixed picture. Its desktop id is dev.ace.GrowFixture (run-renegotiate.sh installs
the .desktop). Usage: python3 grow_window.py
"""
import signal

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import GLib, Gtk  # noqa: E402  # pyright: ignore[reportAttributeAccessIssue]

size = [320, 240]


def activate(app):
    window = Gtk.ApplicationWindow(application=app, title="Grow fixture")
    window.set_decorated(False)
    window.set_resizable(False)
    css = Gtk.CssProvider()
    css.load_from_string("box { background: #1a80e6; } label { color: white; font-size: 32px; }")
    Gtk.StyleContext.add_provider_for_display(window.get_display(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    area = Gtk.Box()
    area.append(Gtk.Label(label="ace grow fixture", hexpand=True))
    area.set_size_request(size[0], size[1])
    window.set_child(area)

    def grow():
        size[0] += 96
        size[1] += 64
        area.set_size_request(size[0], size[1])
        return GLib.SOURCE_CONTINUE

    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR1, grow)
    window.present()


app = Gtk.Application(application_id="dev.ace.GrowFixture")
app.connect("activate", activate)
app.run([])
