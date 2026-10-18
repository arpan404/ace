/*
 * Apps computer use never drives. Password managers and system authentication hold secrets;
 * terminals would let typed text run commands outside the provider's own sandbox and
 * approvals. Everything else follows the provider's permission mode (ADR 0086).
 */
const blocked: ReadonlyMap<string, string> = new Map([
  ["com.apple.keychainaccess", "it holds passwords"],
  ["com.apple.Passwords", "it holds passwords"],
  ["com.1password.1password", "it holds passwords"],
  ["com.agilebits.onepassword7", "it holds passwords"],
  ["com.bitwarden.desktop", "it holds passwords"],
  ["com.dashlane.dashlanephonefinal", "it holds passwords"],
  ["com.lastpass.LastPass", "it holds passwords"],
  ["com.nordpass.macos.NordPass", "it holds passwords"],
  ["me.proton.pass.electron", "it holds passwords"],
  ["com.apple.SecurityAgent", "it is a system authentication prompt"],
  ["com.apple.LocalAuthentication.UIAgent", "it is a system authentication prompt"],
  ["com.apple.loginwindow", "it is a system authentication prompt"],
  ["com.apple.Terminal", "typing there would run commands outside your shell tool's approvals"],
  ["com.googlecode.iterm2", "typing there would run commands outside your shell tool's approvals"],
  ["dev.warp.Warp-Stable", "typing there would run commands outside your shell tool's approvals"],
  ["net.kovidgoyal.kitty", "typing there would run commands outside your shell tool's approvals"],
  ["com.github.wez.wezterm", "typing there would run commands outside your shell tool's approvals"],
  ["com.mitchellh.ghostty", "typing there would run commands outside your shell tool's approvals"],
  ["io.alacritty", "typing there would run commands outside your shell tool's approvals"],
  ["com.cmuxterm.app", "typing there would run commands outside your shell tool's approvals"],
]);

/** Why computer use refuses this app, or undefined when it may proceed. */
export function blockedReason(bundleId: string): string | undefined {
  const reason = blocked.get(bundleId) ?? blocked.get(bundleId.toLowerCase());
  return reason ? `Computer use does not operate this app: ${reason}.` : undefined;
}
