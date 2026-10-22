/**
 * Chrome's Linux sandbox needs unprivileged user namespaces. Ubuntu 23.10+ lets only processes
 * with an AppArmor profile granting `userns` create them
 * (`kernel.apparmor_restrict_unprivileged_userns=1`), so ace's own Chrome needs a profile of its
 * own: unconfined, like the ones Ubuntu ships for Google Chrome and Chromium, plus `userns`.
 * https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md
 * https://documentation.ubuntu.com/release-notes/24.04/ (the `unconfined` profile mode)
 *
 * This file is the one source of those profiles: the desktop package installs ace-chromium,
 * `ace doctor` prints it for a person to install once, and the desktop app's one-time sandbox
 * setup installs it together with the app's own profile. Cursor's sandbox helper needs the same
 * grant (ace-cursor-sandbox, also printed by `ace doctor`).
 */

export const chromiumAppArmorProfileName = "ace-chromium";
export const chromiumAppArmorProfilePath = `/etc/apparmor.d/${chromiumAppArmorProfileName}`;
/** ace's pinned Chrome for Testing under every user's default `ACE_HOME` (`~/.ace`). */
export const defaultChromiumAttachment = "@{HOME}/.ace/chromium/*/chrome-linux{64,-arm64}/chrome";

/** AppArmor's glob characters and quotes, escaped so a literal path matches only itself. */
export function appArmorLiteral(path: string): string {
  return path.replace(/[\\*?[\]{}^"]/g, (char) => `\\${char}`);
}
/** The attachment for ace's Chrome under a data directory other than `~/.ace`. */
export function chromiumAttachmentFor(dataDir: string): string {
  if (!dataDir.startsWith("/")) throw new Error("ACE_HOME must be absolute");
  return `${appArmorLiteral(dataDir.replace(/\/+$/, ""))}/chromium/*/chrome-linux{64,-arm64}/chrome`;
}
/** The attachment for one Chromium executable, such as `ACE_CHROMIUM_PATH`. */
export function chromiumAttachmentForExecutable(executable: string): string {
  if (!executable.startsWith("/")) throw new Error("Chromium executable must be absolute");
  return appArmorLiteral(executable);
}
/**
 * The attachment for the Chromium ace's daemon runs: `chromiumPath` (`ACE_CHROMIUM_PATH`,
 * absolute) when set, else the pinned Chrome under `dataDir`, written portably for `~/.ace`.
 */
export function chromiumAttachmentForEngine(options: {
  dataDir: string;
  home: string;
  chromiumPath?: string;
}): string {
  if (options.chromiumPath) return chromiumAttachmentForExecutable(options.chromiumPath);
  const dataDir = options.dataDir.replace(/\/+$/, "");
  return dataDir === `${options.home.replace(/\/+$/, "")}/.ace`
    ? defaultChromiumAttachment
    : chromiumAttachmentFor(dataDir);
}

/** A profile that lets the executables at `attachment` create user namespaces, and nothing else. */
export interface UsernsProfile {
  /** The profile and its file name under /etc/apparmor.d: `ace-` then a-z, 0-9 and `-`. */
  name: string;
  attachment: string;
  /** One line saying whose profile this is. */
  purpose: string;
}
export function isAceProfileName(name: string): boolean {
  return /^ace-[a-z0-9-]{1,60}$/.test(name);
}

/** The text of `/etc/apparmor.d/<name>`. */
export function usernsProfileText(profile: UsernsProfile): string {
  if (!isAceProfileName(profile.name)) throw new Error("Invalid AppArmor profile name");
  if (/[\n\r\0]/.test(profile.attachment) || /[\n\r\0]/.test(profile.purpose))
    throw new Error("Invalid AppArmor attachment");
  const target = /\s/.test(profile.attachment) ? `"${profile.attachment}"` : profile.attachment;
  return [
    `# ${profile.purpose}`,
    "abi <abi/4.0>,",
    "include <tunables/global>",
    "",
    `profile ${profile.name} ${target} flags=(unconfined) {`,
    "  userns,",
    "",
    `  include if exists <local/${profile.name}>`,
    "}",
    "",
  ].join("\n");
}

/** The profile text, for `/etc/apparmor.d/ace-chromium`. */
export function chromiumAppArmorProfile(attachment = defaultChromiumAttachment): string {
  return usernsProfileText({
    name: chromiumAppArmorProfileName,
    attachment,
    purpose: "ace's Chrome: lets its sandbox create user namespaces on Ubuntu 23.10+.",
  });
}

export const cursorSandboxProfileName = "ace-cursor-sandbox";
/**
 * Where Cursor's sandbox helper runs from. A standalone install keeps each release under
 * `ACE_HOME/releases/<version>-<target>`, so the attachment covers every release there and
 * survives updates; any other copy (a checkout, a custom layout) is attached by its own path.
 * Under the desktop app the helper needs no profile: it inherits the app's.
 */
export function cursorSandboxAttachment(options: {
  /** The helper's resolved path: AppArmor matches executables after symlinks. */
  helper: string;
  dataDir: string;
  home: string;
}): string {
  if (!options.helper.startsWith("/")) throw new Error("Cursor's helper path must be absolute");
  const dataDir = options.dataDir.replace(/\/+$/, "");
  if (!options.helper.startsWith(`${dataDir}/releases/`)) return appArmorLiteral(options.helper);
  const root =
    dataDir === `${options.home.replace(/\/+$/, "")}/.ace`
      ? "@{HOME}/.ace"
      : appArmorLiteral(dataDir);
  return `${root}/releases/*/node_modules/@cursor/sdk-linux-{x64,arm64}/bin/cursorsandbox`;
}
/** The text of `/etc/apparmor.d/ace-cursor-sandbox`. */
export function cursorSandboxProfile(attachment: string): string {
  return usernsProfileText({
    name: cursorSandboxProfileName,
    attachment,
    purpose: "Cursor's sandbox helper in ace: lets it create user namespaces on Ubuntu 23.10+.",
  });
}

/** Shell commands a person runs once to install and load profiles. */
export function appArmorInstallCommands(profiles: { name: string; text: string }[]): string {
  return profiles
    .flatMap(({ name, text }) => {
      if (!isAceProfileName(name)) throw new Error("Invalid AppArmor profile name");
      const path = `/etc/apparmor.d/${name}`;
      return [
        `sudo tee ${path} >/dev/null <<'EOF'`,
        text.trimEnd(),
        "EOF",
        `sudo apparmor_parser -r ${path}`,
      ];
    })
    .join("\n");
}

/** Shell commands a person runs once to install and load the Chrome profile. */
export function chromiumAppArmorInstall(profile = chromiumAppArmorProfile()): string {
  return appArmorInstallCommands([{ name: chromiumAppArmorProfileName, text: profile }]);
}
