import { basename, dirname, join } from "node:path";
import {
  appArmorInstallCommands,
  appArmorLiteral,
  chromiumAppArmorProfile,
  chromiumAppArmorProfileName,
  chromiumAttachmentForEngine,
  usernsProfileText,
} from "@ace/browser/linux-sandbox";
import type { SandboxNotice } from "../../shared/contract.ts";

/**
 * Chromium's sandbox on Linux installs that have no package to set it up (ADR 0093).
 *
 * Ubuntu 23.10+ lets a process create the user namespaces the sandbox needs only under an
 * AppArmor profile that grants `userns`. The deb installs one for `/opt/ace`; an AppImage and an
 * extracted tar.gz can't, so their launchers start Electron with `--no-sandbox` there. This
 * module decides what to offer: one person-approved setup that installs profiles for this
 * copy of the app and for ace's headless Chrome, after which the sandbox is on.
 *
 * Profile text comes from `@ace/browser/linux-sandbox`, the same source as the deb and
 * `ace doctor`. A profile attached to the AppImage file is inherited by everything it starts:
 * the AppRun, its user-namespace probe and Electron on the temporary mount (an unconfined
 * profile keeps its children unless another profile attaches; security/apparmor/domain.c).
 */

/** How this copy of the app was installed, as far as the sandbox setup cares. */
export type LinuxInstall =
  | { kind: "appimage"; image: string }
  | { kind: "tarball"; directory: string }
  /** The deb's `/opt/ace`: its package installs and removes its own profiles. */
  | { kind: "deb" }
  /** Development and unknown layouts: nothing to set up. */
  | { kind: "other" };

export function linuxInstall(
  env: Readonly<Record<string, string | undefined>>,
  execPath: string,
): LinuxInstall {
  const image = env.APPIMAGE;
  if (image?.startsWith("/") && !/[\n\r\0]/.test(image)) return { kind: "appimage", image };
  if (basename(execPath) === "ace-desktop-bin")
    return { kind: "tarball", directory: dirname(execPath) };
  if (dirname(execPath) === "/opt/ace") return { kind: "deb" };
  return { kind: "other" };
}

/** AppArmor alternation members: literal, with the comma that would split them escaped. */
function member(text: string): string {
  return appArmorLiteral(text).replaceAll(",", "\\,");
}
/**
 * The AppImage's attachment. electron-updater keeps a file name without a version and writes a
 * versioned one's update beside it under the feed's name (`ace-<version>-<arch>.AppImage`), so
 * a versioned name also covers the `ace-*.AppImage` files in its folder: the profile survives
 * updates. Moving the file elsewhere needs the setup again, which the app offers.
 */
export function appImageAttachment(image: string): string {
  const folder = appArmorLiteral(dirname(image));
  const name = basename(image);
  // electron-updater's own test for "this name has a version".
  if (!/\d+\.\d+\.\d+/.test(name)) return `${folder}/${appArmorLiteral(name)}`;
  return `${folder}/{${member(name)},ace-*.AppImage}`;
}

export interface SandboxProfile {
  name: string;
  text: string;
}

/** The profile for this copy of the app, one per user so people's copies never collide. */
export function appProfile(install: LinuxInstall, uid: number): SandboxProfile | undefined {
  const name = `ace-desktop-user-${uid}`;
  const attachment =
    install.kind === "appimage"
      ? appImageAttachment(install.image)
      : install.kind === "tarball"
        ? `${appArmorLiteral(install.directory)}/ace-desktop{,-bin}`
        : undefined;
  if (attachment === undefined) return undefined;
  return {
    name,
    text: usernsProfileText({
      name,
      attachment,
      purpose:
        "ace's desktop app: lets Chromium's sandbox create user namespaces on Ubuntu 23.10+.",
    }),
  };
}

/** The ace-chromium profile for the daemon's headless Chrome, exactly as `ace doctor` prints it. */
export function browserProfile(options: {
  dataDir: string;
  home: string;
  chromiumPath?: string;
}): SandboxProfile {
  return {
    name: chromiumAppArmorProfileName,
    text: chromiumAppArmorProfile(chromiumAttachmentForEngine(options)),
  };
}

export interface SandboxFacts {
  /** `kernel.apparmor_restrict_unprivileged_userns` is 1. */
  restricted: boolean;
  /** Electron runs with `--no-sandbox`. */
  appUnsandboxed: boolean;
  /** This copy's profile, when its install kind can have one. */
  app?: SandboxProfile;
  /** The headless Chrome's profile, when the daemon runs on this machine with its sandbox. */
  browser?: SandboxProfile;
  /** The text of `/etc/apparmor.d/<name>`, if any. */
  installed(name: string): string | undefined;
}

/** The profiles the setup installs: the app's while it runs unsandboxed, Chrome's if not current. */
export function profilesToInstall(facts: SandboxFacts): SandboxProfile[] {
  if (!facts.restricted) return [];
  const needed: SandboxProfile[] = [];
  if (facts.app && facts.appUnsandboxed) needed.push(facts.app);
  if (facts.browser && facts.installed(facts.browser.name) !== facts.browser.text)
    needed.push(facts.browser);
  return needed;
}

/** The one sentence that says what is off and what it costs. */
export function offerSentence(profiles: readonly SandboxProfile[]): string {
  const app = profiles.some((profile) => profile.name !== chromiumAppArmorProfileName);
  const browser = profiles.some((profile) => profile.name === chromiumAppArmorProfileName);
  if (app && browser)
    return "AppArmor keeps Chromium's sandbox off here, so web pages in ace run without it and agents can't use the headless browser.";
  if (app) return "AppArmor keeps Chromium's sandbox off here, so web pages in ace run without it.";
  return "AppArmor blocks the sandbox of ace's headless browser, so agents can't use it yet.";
}

export function offer(profiles: readonly SandboxProfile[]): SandboxNotice {
  return profiles.length === 0
    ? { state: "hidden" }
    : { state: "offer", sentence: offerSentence(profiles) };
}

/** The same setup as terminal commands, for a machine with no password prompt or a failed one. */
export function commandsNotice(
  profiles: readonly SandboxProfile[],
  reason: "no-prompt" | "failed",
): SandboxNotice {
  return {
    state: "commands",
    sentence:
      reason === "failed"
        ? "The sandbox setup didn't finish; run its commands in a terminal instead."
        : "Copy the sandbox setup's commands and run them in a terminal; ace can't ask for your password here.",
    commands: appArmorInstallCommands(profiles.map(({ name, text }) => ({ name, text }))),
  };
}

/** After the setup: Electron picks its sandbox up only when it starts again. */
export function afterSetup(installed: readonly SandboxProfile[]): SandboxNotice {
  return installed.some((profile) => profile.name !== chromiumAppArmorProfileName)
    ? { state: "restart", sentence: "The sandbox is set up; restart ace to turn it on." }
    : { state: "hidden" };
}

/** How to start this copy again with its sandbox: through its launcher, never `--no-sandbox`. */
export function relaunchCommand(
  install: LinuxInstall,
  argv: readonly string[],
): { execPath: string; args: string[] } | undefined {
  const args = argv.slice(1).filter((arg) => arg !== "--no-sandbox");
  if (install.kind === "appimage") return { execPath: install.image, args };
  if (install.kind === "tarball") return { execPath: join(install.directory, "ace-desktop"), args };
  return undefined;
}
