#!/bin/bash
# Test-only: stands in for the person answering the screen-sharing chooser on Hyprland.
# xdg-desktop-portal-hyprland runs `screencopy:custom_picker_binary` instead of
# hyprland-share-picker, its own documented setting for a different chooser. ace never
# configures it: the e2e runner writes it into the throwaway session's config only.
#
# The answer is read from $ACE_E2E_PICKER_CHOICE (a file the test writes before it asks):
#   window <class>  share that app's window and allow it to be remembered
#   screen          share the first monitor and allow it to be remembered
#   cancel          decline
#   (missing)       nobody answers: wait, as an unanswered dialog does, then decline
# Every run appends one line to $ACE_E2E_PICKER_CHOICE.log, so a test can tell whether the
# person was asked at all.
# Usage: portal-picker.sh   (XDPH runs its picker without arguments)
set -u
choice_file=${ACE_E2E_PICKER_CHOICE:-}
log=${choice_file:+$choice_file.log}

answer() {
  [ -n "$choice_file" ] && [ -f "$choice_file" ] && head -n 1 "$choice_file"
}

choice=$(answer)
[ -n "$log" ] && printf 'asked %s\n' "${choice:-nobody}" >>"$log"
if [ -z "$choice" ]; then
  # An unanswered chooser: hold for a while (the portal waits on it), then decline.
  for _ in $(seq 600); do
    sleep 0.5
    choice=$(answer)
    [ -n "$choice" ] && break
  done
  [ -z "$choice" ] && exit 1
fi

case "$choice" in
  window\ *)
    class=${choice#window }
    # XDPH_WINDOW_SHARING_LIST: <handle>[HC>]<class>[HT>]<title>[HE>]<address>[HA>] per window.
    list=${XDPH_WINDOW_SHARING_LIST:-}
    while [ -n "$list" ]; do
      entry=${list%%"[HA>]"*}
      if [ "$entry" = "$list" ]; then list=""; else list=${list#*"[HA>]"}; fi
      handle=${entry%%"[HC>]"*}
      rest=${entry#*"[HC>]"}
      window_class=${rest%%"[HT>]"*}
      if [ "$window_class" = "$class" ]; then
        echo "[SELECTION]r/window:$handle"
        exit 0
      fi
    done
    echo "no window of class $class in: ${XDPH_WINDOW_SHARING_LIST:-}" >&2
    exit 1
    ;;
  screen)
    output=$(hyprctl monitors -j 2>/dev/null | sed -n 's/.*"name": "\([^"]*\)".*/\1/p' | head -n 1)
    echo "[SELECTION]r/screen:${output:-Virtual-1}"
    ;;
  *)
    exit 1
    ;;
esac
