#!/bin/sh
# ace's desktop app from the tar.gz: `ace-desktop` starts Electron (`ace-desktop-bin`).
#
# Chromium's sandbox needs unprivileged user namespaces, or a setuid-root chrome-sandbox.
# Where neither works (Ubuntu 23.10+ restricts user namespaces through AppArmor until ace's
# profile is set up), Electron would abort at start, so it starts without the sandbox and the
# app says so and offers the one-time setup. It never turns the sandbox off where it works.
here=$(dirname "$(readlink -f "$0")")
bin="$here/ace-desktop-bin"

for arg in "$@"; do
  [ "$arg" = --no-sandbox ] && exec "$bin" "$@"
done

namespaces_work() {
  if command -v unshare >/dev/null 2>&1; then
    unshare -Ur true 2>/dev/null
    return
  fi
  # No unshare to try: trust the switches that would block them.
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" != 1 ] &&
    [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" != 0 ]
}
setuid_helper_ready() {
  [ -u "$here/chrome-sandbox" ] && [ "$(stat -c %u "$here/chrome-sandbox" 2>/dev/null)" = 0 ]
}

if namespaces_work || setuid_helper_ready; then
  exec "$bin" "$@"
fi
echo "ace: starting without Chromium's sandbox; the app offers to set it up" >&2
exec "$bin" --no-sandbox "$@"
