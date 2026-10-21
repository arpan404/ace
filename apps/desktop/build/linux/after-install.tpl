#!/bin/sh
# deb postinst for ace's desktop app. electron-builder fills in the two macros below.
app='/opt/${sanitizedProductName}'
name='${executable}'

# The GUI command is ace-desktop; `ace` stays free for the daemon CLI.
if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --install "/usr/bin/$name" "$name" "$app/$name" 100 || ln -sf "$app/$name" "/usr/bin/$name"
else
  ln -sf "$app/$name" "/usr/bin/$name"
fi

# Electron's setuid sandbox helper is needed only where unprivileged user namespaces are off.
if [ -L /proc/self/ns/user ] && unshare --user true 2>/dev/null; then
  chmod 0755 "$app/chrome-sandbox" || true
else
  chmod 4755 "$app/chrome-sandbox" || true
fi

command -v update-mime-database >/dev/null 2>&1 && update-mime-database /usr/share/mime || true
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database /usr/share/applications || true

# Ubuntu 23.10+ restricts unprivileged user namespaces through AppArmor. Two profiles grant
# them: the Electron app's, and ace's downloaded headless Chromium's. Each is installed only
# when this AppArmor can parse it (abi 4.0; older releases need neither) and loaded only
# outside a chroot (image builds load it at boot).
install_profile() {
  source_file="$1"
  target_file="/etc/apparmor.d/$2"
  if apparmor_parser --skip-kernel-load --debug "$source_file" >/dev/null 2>&1; then
    cp -f "$source_file" "$target_file"
    if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; then
      apparmor_parser --replace --write-cache --skip-read-cache "$target_file" || true
    fi
  else
    echo "Skipping AppArmor profile $2: this AppArmor does not support it"
  fi
}
if command -v apparmor_parser >/dev/null 2>&1 && command -v apparmor_status >/dev/null 2>&1 \
  && apparmor_status --enabled >/dev/null 2>&1; then
  install_profile "$app/resources/apparmor-profile" "$name"
  install_profile "$app/resources/apparmor-chromium" ace-chromium
fi
exit 0
