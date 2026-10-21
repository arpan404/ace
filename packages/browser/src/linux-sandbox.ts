/**
 * Chrome's Linux sandbox needs unprivileged user namespaces. Ubuntu 23.10+ lets only processes
 * with an AppArmor profile granting `userns` create them
 * (`kernel.apparmor_restrict_unprivileged_userns=1`), so ace's own Chrome needs a profile of its
 * own: unconfined, like the ones Ubuntu ships for Google Chrome and Chromium, plus `userns`.
 * https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md
 *
 * This file is the one source of that profile: the desktop package installs it, and
 * `ace doctor` prints it for a person to install once.
 */

export const chromiumAppArmorProfileName = "ace-chromium";
export const chromiumAppArmorProfilePath = `/etc/apparmor.d/${chromiumAppArmorProfileName}`;
/** ace's pinned Chrome for Testing under every user's default `ACE_HOME` (`~/.ace`). */
export const defaultChromiumAttachment = "@{HOME}/.ace/chromium/*/chrome-linux{64,-arm64}/chrome";

/** AppArmor's glob characters and quotes, escaped so a literal path matches only itself. */
function literal(path: string): string {
  return path.replace(/[\\*?[\]{}^"]/g, (char) => `\\${char}`);
}
/** The attachment for ace's Chrome under a data directory other than `~/.ace`. */
export function chromiumAttachmentFor(dataDir: string): string {
  if (!dataDir.startsWith("/")) throw new Error("ACE_HOME must be absolute");
  return `${literal(dataDir.replace(/\/+$/, ""))}/chromium/*/chrome-linux{64,-arm64}/chrome`;
}
/** The attachment for one Chromium executable, such as `ACE_CHROMIUM_PATH`. */
export function chromiumAttachmentForExecutable(executable: string): string {
  if (!executable.startsWith("/")) throw new Error("Chromium executable must be absolute");
  return literal(executable);
}

/** The profile text, for `/etc/apparmor.d/ace-chromium`. */
export function chromiumAppArmorProfile(attachment = defaultChromiumAttachment): string {
  if (/[\n\r\0]/.test(attachment)) throw new Error("Invalid AppArmor attachment");
  const target = /\s/.test(attachment) ? `"${attachment}"` : attachment;
  return [
    "# ace's Chrome: lets its sandbox create user namespaces on Ubuntu 23.10+.",
    "abi <abi/4.0>,",
    "include <tunables/global>",
    "",
    `profile ${chromiumAppArmorProfileName} ${target} flags=(unconfined) {`,
    "  userns,",
    "",
    `  include if exists <local/${chromiumAppArmorProfileName}>`,
    "}",
    "",
  ].join("\n");
}

/** Shell commands a person runs once to install and load the profile. */
export function chromiumAppArmorInstall(profile = chromiumAppArmorProfile()): string {
  return [
    `sudo tee ${chromiumAppArmorProfilePath} >/dev/null <<'EOF'`,
    profile.trimEnd(),
    "EOF",
    `sudo apparmor_parser -r ${chromiumAppArmorProfilePath}`,
  ].join("\n");
}
