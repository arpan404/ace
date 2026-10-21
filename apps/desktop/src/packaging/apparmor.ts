/**
 * The AppArmor profile that lets ace's headless Chromium use its sandbox on Ubuntu 23.10+,
 * where unprivileged user namespaces are restricted (ADR 0091). It grants exactly that
 * (`userns`) to the Chrome binary ace downloads under the data home, and confines nothing
 * else. The deb installs it beside electron-builder's profile for the Electron binary.
 *
 * Reconcile with packages/browser: the browser package is adding the canonical profile text
 * (the one-time sandbox fix it reports). When that export lands, return it from here instead
 * of this copy, so the profile is defined once.
 */
export const chromiumAppArmorProfileName = "ace-chromium";

/** The Chrome binaries ace downloads: `~/.ace/chromium/<build>/.../chrome`. */
export const chromiumAppArmorAttachment = "@{HOME}/.ace/chromium/**/chrome";

export function chromiumAppArmorProfile(): string {
  return [
    "# ace: lets ace's downloaded Chromium create its sandbox (unprivileged user namespaces).",
    "abi <abi/4.0>,",
    "include <tunables/global>",
    "",
    `profile ${chromiumAppArmorProfileName} ${chromiumAppArmorAttachment} flags=(unconfined) {`,
    "  userns,",
    "",
    "  # Site-specific additions and overrides. See local/README for details.",
    `  include if exists <local/${chromiumAppArmorProfileName}>`,
    "}",
    "",
  ].join("\n");
}
