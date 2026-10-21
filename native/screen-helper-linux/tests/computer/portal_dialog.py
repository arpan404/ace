"""Test-only: looks at and cancels the portal's "Share Screen" dialog through AT-SPI directly
(the helper refuses portals as targets, as it should). Needs gir1.2-atspi-2.0."""
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402  # pyright: ignore[reportAttributeAccessIssue]

TITLE = "Share Screen"


def _dialog():
    desktop = Atspi.get_desktop(0)
    for index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(index)
        if not app or "portal" not in (app.get_name() or "").lower():
            continue
        for window_index in range(app.get_child_count()):
            window = app.get_child_at_index(window_index)
            if window and window.get_name() == TITLE:
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


def is_open(wait: float = 3.0) -> bool:
    deadline = time.time() + wait
    while True:
        if _dialog() is not None:
            return True
        if time.time() > deadline:
            return False
        time.sleep(0.3)


def cancel() -> bool:
    """Presses Cancel, as the person would."""
    if not is_open():
        return False
    button = _find(_dialog(), "button", "Cancel")
    if button is None:
        return False
    return bool(Atspi.Action.do_action(button, 0))
