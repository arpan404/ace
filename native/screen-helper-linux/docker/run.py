"""Ephemeral integration image/container. Never prune the user's Docker resources."""
import os
from pathlib import Path
import subprocess
import sys
import uuid

root = Path(__file__).resolve().parent.parent
name = "ace-screen-linux-test-" + uuid.uuid4().hex
image = name + ":test"
platform = os.environ.get("ACE_TEST_PLATFORM", "linux/amd64")
built = False
try:
    subprocess.run(["docker", "info"], timeout=30, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["docker", "build", "--platform", platform, "--label", "ace.ephemeral="+name, "-t", image, str(root)], timeout=1800, check=True)
    built = True
    subprocess.run(["docker", "run", "--name", name, "--rm", "--platform", platform, "--shm-size", "128m", image] + sys.argv[1:], timeout=300, check=True)
finally:
    # Bounded cleanup also runs after test failures and interrupts. No volume, system or image prune.
    for command in (["docker", "rm", "-f", name], ["docker", "image", "rm", "-f", image]):
        try:
            subprocess.run(command, timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (subprocess.TimeoutExpired, OSError):
            pass
