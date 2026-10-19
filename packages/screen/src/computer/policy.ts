/*
 * Apps computer use never drives. Password managers and system authentication hold secrets;
 * terminals and script runners would let typed text run commands outside the provider's own
 * sandbox and approvals; ace itself shows the approvals agents must not answer. The person
 * can add apps of their own. Everything else follows the provider's permission mode (ADR 0086).
 */
const passwords = "it holds passwords";
const authentication = "it is a system authentication prompt";
const shell = "typing there would run commands outside your shell tool's approvals";
const scripts = "it runs scripts and shell commands outside your shell tool's approvals";
const ace = "it is ace itself, where the person answers agents' requests";

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
    ] as const
  ).map(([bundleId, reason]) => [bundleId.toLowerCase(), reason]),
);

/**
 * Why computer use refuses this app, or undefined when it may proceed. `personBlocked` holds
 * the person's own list: bundle ids or app names, matched without regard to case.
 */
export function blockedReason(
  app: { bundleId: string; name?: string | undefined },
  personBlocked: readonly string[] = [],
): string | undefined {
  const bundleId = app.bundleId.toLowerCase();
  const reason = builtIn.get(bundleId);
  if (reason) return `Computer use does not operate this app: ${reason}.`;
  const name = app.name?.trim().toLowerCase();
  const listed = personBlocked.some((entry) => {
    const wanted = entry.trim().toLowerCase();
    return wanted !== "" && (wanted === bundleId || wanted === name);
  });
  return listed
    ? "Computer use does not operate this app: the person listed it under Apps agents can't use, in Settings › Computer use. Do not try another way into it."
    : undefined;
}
