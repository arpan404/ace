"""Live check of the person's side of `--computer` on Hyprland (Omarchy's desktop; see
run-hyprland.sh). The person's input is watched through the compositor's ext-idle-notify, the
"ace is using" notice shows in mako, and the person's Stop there (makoctl invoke, as a click on
the notification does) stops the next action.
"""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from helper import Helper, find  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool, detail: object = "") -> None:
    print(("ok   " if condition else "FAIL ") + name + ("" if condition else f"\n     {detail}"))
    if not condition:
        failures.append(name)


def mako() -> str:
    return subprocess.run(["makoctl", "list"], capture_output=True, text=True).stdout


def main() -> None:
    subprocess.Popen(["gnome-calculator"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(5)
    helper = Helper(sys.argv[1])
    try:
        person = helper.result("hello").get("person", {})
        check("hello says the person's input comes from the compositor and notices can show",
              person.get("idle") == "wayland" and person.get("notifications") is True, person)
        look = helper.result("state", app="calculator")
        seven = find(look, name="7")
        acted = helper.result("act", app="calculator", actions=[{"type": "click", "id": seven["id"]}])
        time.sleep(1)
        listed = mako()
        check("an act shows \"ace is using Calculator\" with Stop in mako",
              "error" not in acted and "ace is using Calculator" in listed and "stop: Stop" in listed, listed)
        number = next((line.split()[1].rstrip(":") for line in listed.splitlines() if "ace is using" in line), "")
        invoked = subprocess.run(["makoctl", "invoke", "-n", number, "stop"], capture_output=True, text=True)
        check("the person presses Stop in mako", invoked.returncode == 0, invoked)
        time.sleep(1)
        stopped = helper.result("act", app="calculator", actions=[{"type": "click", "id": seven["id"]}])
        check("the next action stops, telling the agent to ask the person",
              stopped.get("error", {}).get("code") == "stopped_by_person", stopped)
        check("the notice is withdrawn", "ace is using" not in mako(), mako())
    finally:
        helper.close()
    print(f"{len(failures)} failed" if failures else "all passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
