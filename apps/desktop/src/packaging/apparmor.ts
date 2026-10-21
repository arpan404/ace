/**
 * The AppArmor profile that lets ace's headless Chromium use its sandbox on Ubuntu 23.10+,
 * where unprivileged user namespaces are restricted (ADR 0091). It grants exactly that
 * (`userns`) to the Chrome for Testing binary ace downloads under the default data home, and
 * confines nothing else. The deb installs it beside electron-builder's profile for Electron.
 *
 * Reconcile with packages/browser: the browser work adds the canonical text as
 * `chromiumAppArmorProfile()` in `@ace/browser` (linux-sandbox.ts), with this same name and
 * attachment, for `ace doctor` to print. When that export is on main, re-export it from here
 * and delete this copy, so the profile is defined once.
 */
export const chromiumAppArmorProfileName = "ace-chromium";

/** ace's pinned Chrome for Testing under every user's default `ACE_HOME` (`~/.ace`). */
export const chromiumAppArmorAttachment = "@{HOME}/.ace/chromium/*/chrome-linux{64,-arm64}/chrome";

export function chromiumAppArmorProfile(): string {
  return [
    "# ace's Chrome: lets its sandbox create user namespaces on Ubuntu 23.10+.",
    "abi <abi/4.0>,",
    "include <tunables/global>",
    "",
    `profile ${chromiumAppArmorProfileName} ${chromiumAppArmorAttachment} flags=(unconfined) {`,
    "  userns,",
    "",
    `  include if exists <local/${chromiumAppArmorProfileName}>`,
    "}",
    "",
  ].join("\n");
}
