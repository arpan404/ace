/*
 * Apps computer use never drives. Password managers and system authentication hold secrets;
 * terminals and script runners would let typed text run commands outside the provider's own
 * sandbox and approvals; ace itself shows the approvals agents must not answer. The person
 * can add apps of their own. Entries cover macOS bundle ids and Linux desktop-file ids and
 * executable names, matched without regard to case. Everything else follows the provider's permission mode (ADR 0086).
 */
const passwords = "it holds passwords";
const authentication = "it is a system authentication prompt";
const shell = "typing there would run commands outside your shell tool's approvals";
const scripts = "it runs scripts and shell commands outside your shell tool's approvals";
const ace = "it is ace itself, where the person answers agents' requests";

const linuxTerminals = [
  "org.gnome.Terminal",
  "gnome-terminal",
  "gnome-terminal-server",
  "org.gnome.Ptyxis",
  "app.devsuite.Ptyxis",
  "ptyxis",
  "org.gnome.Console",
  "kgx",
  "org.kde.konsole",
  "konsole",
  "org.kde.yakuake",
  "yakuake",
  "xterm",
  "uxterm",
  "debian-xterm",
  "debian-uxterm",
  "kitty",
  "Alacritty",
  "foot",
  "footclient",
  "org.codeberg.dnkl.foot",
  "tilix",
  "com.gexperts.Tilix",
  "org.wezfurlong.wezterm",
  "wezterm",
  "wezterm-gui",
  "ghostty",
  "terminator",
  "xfce4-terminal",
  "org.xfce.terminal",
  "lxterminal",
  "qterminal",
  "urxvt",
  "rxvt-unicode",
  "io.elementary.terminal",
  "com.raggesilver.BlackBox",
  "guake",
  "terminology",
  "deepin-terminal",
  "sakura",
  "warp-terminal",
] as const;
const linuxPasswords = [
  "org.keepassxc.KeePassXC",
  "keepassxc",
  "keepass2",
  "org.gnome.seahorse.Application",
  "seahorse",
  "bitwarden",
  "1password",
  "org.gnome.World.Secrets",
  "org.gnome.PasswordSafe",
  "gnome-passwordsafe",
  "kwalletmanager",
  "kwalletmanager5",
  "org.kde.kwalletmanager",
  "org.kde.kwalletmanager5",
  "me.proton.Pass",
  "proton-pass",
  // KDE's wallet: Plasma 6's secret service (ksecretd) and the older KWallet daemons.
  "org.kde.ksecretd",
  "ksecretd",
  "kwalletd6",
  "kwalletd5",
] as const;
const linuxAuthentication = [
  "gcr-prompter",
  "gcr4-prompter",
  "org.gnome.keyring.SystemPrompter",
  "ksshaskpass",
  "org.kde.ksshaskpass",
  "ssh-askpass",
  // Plasma 6 asks for the wallet password in its secret prompter; kdesu asks for root's.
  "org.kde.secretprompter",
  "ksecretprompter",
  "kdesu",
  "org.kde.kdesu",
] as const;

const builtIn: ReadonlyMap<string, string> = new Map(
  (
    [
      ["com.apple.keychainaccess", passwords],
      ["com.apple.Passwords", passwords],
      ["com.1password.1password", passwords],
      ["com.agilebits.onepassword7", passwords],
      ["com.bitwarden.desktop", passwords],
      ["com.dashlane.dashlanephonefinal", passwords],
      ["com.lastpass.LastPass", passwords],
      ["com.nordpass.macos.NordPass", passwords],
      ["me.proton.pass.electron", passwords],
      ["com.apple.SecurityAgent", authentication],
      ["com.apple.LocalAuthentication.UIAgent", authentication],
      ["com.apple.loginwindow", authentication],
      ["com.apple.Terminal", shell],
      ["com.googlecode.iterm2", shell],
      ["dev.warp.Warp-Stable", shell],
      ["dev.warp.Warp-Preview", shell],
      ["net.kovidgoyal.kitty", shell],
      ["com.github.wez.wezterm", shell],
      ["com.mitchellh.ghostty", shell],
      ["io.alacritty", shell],
      ["org.alacritty", shell],
      ["com.cmuxterm.app", shell],
      ["co.zeit.hyper", shell],
      ["org.tabby", shell],
      ["com.raphaelamorim.rio", shell],
      ["com.termius-dmg.mac", shell],
      ["com.panic.Prompt3", shell],
      ["com.apple.ScriptEditor2", scripts],
      ["com.apple.Automator", scripts],
      ["com.apple.shortcuts", scripts],
      ["dev.ace.app", ace],
      ["dev.ace.screen-helper", ace],
      // Linux identities: desktop-file ids (Flatpak app ids included) and, for apps found
      // only by window class or process, executable names.
      ...linuxTerminals.map((id) => [id, shell] as const),
      ...linuxPasswords.map((id) => [id, passwords] as const),
      ...linuxAuthentication.map((id) => [id, authentication] as const),
      ["ace-desktop", ace],
      ["ace-screen-helper-linux", ace],
    ] as const
  ).map(([bundleId, reason]) => [bundleId.toLowerCase(), reason]),
);

/** Linux auth prompts come in many builds: any polkit agent and any pinentry. */
const authenticationPatterns: readonly RegExp[] = [/polkit|policykit/, /^pinentry/];

/**
 * Why computer use refuses this app, or undefined when it may proceed. `personBlocked` holds
 * the person's own list: bundle ids or app names, matched without regard to case.
 */
export function blockedReason(
  app: { bundleId: string; name?: string | undefined },
  personBlocked: readonly string[] = [],
): string | undefined {
  const bundleId = app.bundleId.toLowerCase();
  const name = app.name?.trim().toLowerCase();
  const reason =
    builtIn.get(bundleId) ??
    (authenticationPatterns.some(
      (pattern) => pattern.test(bundleId) || (name !== undefined && pattern.test(name)),
    )
      ? authentication
      : undefined);
  if (reason) return `Computer use does not operate this app: ${reason}.`;
  const listed = personBlocked.some((entry) => {
    const wanted = entry.trim().toLowerCase();
    return wanted !== "" && (wanted === bundleId || wanted === name);
  });
  return listed
    ? "Computer use does not operate this app: the person listed it under Apps agents can't use, in Settings › Computer use. Do not try another way into it."
    : undefined;
}
