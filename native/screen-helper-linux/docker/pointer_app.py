"""Separate X11 fixture process with observable button and wheel effects."""
import json
import os
import select
import sys
from Xlib import X, Xatom, display

conn = display.Display()
root = conn.screen().root
other = sys.argv[1] == "other"
window = root.create_window(700 if other else 50, 50, 200 if other else 400, 200,
                            0, conn.screen().root_depth, X.InputOutput, X.CopyFromParent,
                            background_pixel=conn.screen().white_pixel,
                            override_redirect=other, event_mask=X.ButtonPressMask)
window.set_wm_class("pointer-fixture", "AcePointerOther" if other else "AcePointerTarget")
window.change_property(conn.intern_atom("_NET_WM_PID"), Xatom.CARDINAL, 32, [os.getpid()])
window.set_wm_name("Unapproved" if other else "Approved")
window.map()
conn.sync()
print("READY:" + str(window.id), flush=True)
presses = 0
wheels = 0

def grab_failed(error, request):
    raise RuntimeError("Passive grab was not installed: " + str(error))

def events():
    global presses, wheels
    while conn.pending_events():
        event = conn.next_event()
        if event.type == X.ButtonPress:
            if event.detail in [4, 5, 6, 7]:
                wheels += 1
            else:
                presses += 1

while True:
    ready, _, _ = select.select([conn.fileno(), sys.stdin], [], [])
    if conn.fileno() in ready:
        events()
    if sys.stdin in ready:
        line = sys.stdin.readline()
        if not line:
            break
        command = json.loads(line)
        if command[0] == "move":
            window.configure(x=command[1], y=command[2], width=command[3], height=command[4], stack_mode=X.Above)
        elif command[0] == "grab":
            status = window.grab_pointer(False, X.ButtonPressMask, X.GrabModeAsync, X.GrabModeAsync, X.NONE, X.NONE, X.CurrentTime)
            assert status == X.GrabSuccess
        elif command[0] == "passive":
            # An inactive root grab passes an active GrabPointer probe, then steals a press.
            root.grab_button(X.AnyButton, X.AnyModifier, False, X.ButtonPressMask,
                             X.GrabModeAsync, X.GrabModeAsync, X.NONE, X.NONE, onerror=grab_failed)
        elif command[0] == "unpassive":
            root.ungrab_button(X.AnyButton, X.AnyModifier)
        elif command[0] == "ungrab":
            conn.ungrab_pointer(X.CurrentTime)
        conn.sync()
        events()
        print(json.dumps(dict(presses=presses, wheels=wheels)), flush=True)
