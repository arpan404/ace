#!/bin/sh
# deb postrm for ace's desktop app. electron-builder fills in the two macros below.
app='/opt/${sanitizedProductName}'
name='${executable}'
# An upgrade runs this too; the new version's postinst keeps the command and profiles.
case "$1" in remove | purge) ;; *) exit 0 ;; esac

if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove "$name" "$app/$name" || true
else
  rm -f "/usr/bin/$name"
fi

# Unload, then delete, both AppArmor profiles the postinst installed. AppArmor is touched
# only when present and enabled, and never inside a chroot.
for profile in "$name" ace-chromium; do
  file="/etc/apparmor.d/$profile"
  [ -f "$file" ] || continue
  if command -v apparmor_parser >/dev/null 2>&1 && command -v apparmor_status >/dev/null 2>&1 \
    && apparmor_status --enabled >/dev/null 2>&1 \
    && ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; then
    apparmor_parser --remove "$file" || true
  fi
  rm -f "$file"
done
exit 0
