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

# The `ace` command (the daemon CLI) on PATH from install, before the app is first opened. It is
# the same script the app writes to ~/.ace/bin/ace on launch (cli-shim.ts renderCliShim, marker
# included), so the app treats it as its own command. An /usr/bin/ace that ace didn't write is
# never replaced.
cli=/usr/bin/ace
marker='ace-cli-shim: written by the ace desktop app on launch'
if { [ ! -e "$cli" ] && [ ! -L "$cli" ]; } || { [ -f "$cli" ] && [ ! -L "$cli" ] && grep -qF "$marker" "$cli"; }; then
  next="$cli.ace-new"
  if printf '#!/bin/sh\n# %s\nexec %s --disable-warning=ExperimentalWarning %s "$@"\n' \
    "$marker" "'$app/resources/runtime/bin/node'" "'$app/resources/daemon/ace.mjs'" >"$next" \
    && chmod 0755 "$next" && mv -f "$next" "$cli"; then
    :
  else
    rm -f "$next"
    echo "Could not install $cli; open ace once to set up the ace command"
  fi
else
  echo "Leaving $cli unchanged: it is not ace's command"
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
