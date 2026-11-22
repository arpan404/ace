import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";

/*
 * When this app may keep a device key for the person's standing (ADR 0190, amendment 1). A key
 * kept across restarts is only as safe as the store that seals it and the app that unseals it,
 * so it is kept only by a packaged app running from its default profile, with no debugging
 * switch:
 *
 * - macOS: only ace's release build, signed by ace's team with ace's designated requirement.
 *   The keychain releases the sealing key to that signature alone. Unsigned, ad-hoc and
 *   development builds prove per window, as before.
 * - Windows (DPAPI) and Linux (Secret Service; never `basic_text`): kept, with the limit the ADR
 *   names: any unsandboxed process of the same user can unseal it there.
 */

/** ace's Apple Developer team. */
export const ACE_TEAM_ID = "5J88TLUP2J";
/** The requirement the running app must meet on macOS: ace's identifier, signed by ace's team. */
export const ACE_REQUIREMENT = `identifier "dev.ace.app" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${ACE_TEAM_ID}"`;

/** Chromium switches that would let another process drive this app or read its memory. */
export const DEBUG_SWITCHES = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "remote-debugging-address",
  "inspect",
  "inspect-brk",
  "inspect-port",
  "js-flags",
] as const;

export interface GateFacts {
  platform: NodeJS.Platform;
  packaged: boolean;
  /** The profile this run uses, and the one a plain launch uses. */
  userData: string;
  defaultUserData: string;
  /** A `--user-data-dir` switch or `ACE_DESKTOP_USER_DATA` was given. */
  profileOverridden: boolean;
  /** Any of `DEBUG_SWITCHES` was given. */
  debugging: boolean;
  /** The OS store can seal without plaintext (Linux `basic_text` can't). */
  sealing: boolean;
}

/** Why a key can't be kept here, or undefined when it can (pending macOS's signature check). */
export function keptKeyRefusal(facts: GateFacts): string | undefined {
  if (!facts.packaged) return "a development build proves per window";
  if (facts.debugging) return "a debugging switch is on";
  if (facts.profileOverridden || resolve(facts.userData) !== resolve(facts.defaultUserData))
    return "this run uses another profile";
  if (!facts.sealing) return "the OS store can't seal it";
  if (!["darwin", "win32", "linux"].includes(facts.platform)) return "unsupported platform";
  return undefined;
}

/** The `.app` bundle the running executable is in (`…/ace.app/Contents/MacOS/ace`). */
export function bundleOf(execPath: string): string {
  return dirname(dirname(dirname(execPath)));
}

/** Whether the bundle at `bundle` is ace's release build: `codesign` checks the requirement. */
export function signedByAce(bundle: string, run: typeof execFile = execFile): Promise<boolean> {
  return new Promise((done) => {
    run(
      "/usr/bin/codesign",
      ["--verify", "--strict", `-R=${ACE_REQUIREMENT}`, bundle],
      { timeout: 10_000 },
      (error) => done(error === null),
    );
  });
}

/**
 * Whether this run may keep the person's device key: the facts, and on macOS the running
 * bundle's signature (checked once, then remembered for the run).
 */
export function keptKeyGate(facts: GateFacts, signed: () => Promise<boolean>) {
  let verdict: Promise<boolean> | undefined;
  return (): Promise<boolean> => {
    verdict ??=
      keptKeyRefusal(facts) !== undefined
        ? Promise.resolve(false)
        : facts.platform === "darwin"
          ? signed().catch(() => false)
          : Promise.resolve(true);
    return verdict;
  };
}
