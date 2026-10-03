"""Isolated GTK app. Prints observable effects and renders them in its labels."""
import gi
import sys
import threading

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib

window = Gtk.Window(title="ace Linux integration")
window.set_wmclass("ace-test", "AceScreenTest")
window.set_default_size(400, 300)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
window.add(box)
entry = Gtk.Entry()
entry.get_accessible().set_name("Message")
box.pack_start(entry, False, False, 0)
button = Gtk.Button(label="Change")
box.pack_start(button, False, False, 0)
label = Gtk.Label(label="unchanged")
box.pack_start(label, False, False, 0)

def clicked(_):
    label.set_text("changed")
    print("CLICKED", flush=True)
button.connect("clicked", clicked)
entry.connect("changed", lambda e: print("TEXT:" + e.get_text(), flush=True))
entry.connect("key-press-event", lambda e, k: print("KEY:" + str(k.keyval), flush=True) or False)
window.connect("destroy", Gtk.main_quit)
window.connect("map-event", lambda *_: print("READY", flush=True))
window.show_all()

def commands():
    for line in sys.stdin:
        command = line.strip()
        if command == "change":
            GLib.idle_add(lambda: clicked(button))
        elif command == "animate":
            counter = [0]
            def tick():
                counter[0] += 1
                label.set_text("frame " + str(counter[0]))
                return True
            GLib.idle_add(lambda: GLib.timeout_add(100, tick) and False)
        elif command == "large":
            def large():
                for i in range(300):
                    child = Gtk.Label(label="item " + str(i))
                    box.pack_start(child, False, False, 0)
                    child.show()
                print("LARGE", flush=True)
            GLib.idle_add(large)
        elif command == "quit":
            GLib.idle_add(window.destroy)
threading.Thread(target=commands, daemon=True).start()
Gtk.main()
