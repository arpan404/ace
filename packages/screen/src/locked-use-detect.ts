import type { LockedUseStatus } from "@ace/protocol";
import {
  codesignPath,
  launchctlPath,
  lockedUseBrokerLabel,
  lockedUseBundleId,
  lockedUseBundlePath,
  lockedUseGuardianLabel,
  lockedUseMechanism,
  lockedUsePermitRight,
  lockedUseRight,
  plutilPath,
  securityPath,
  type MacHost,
} from "./locked-use-host.ts";
import { parsePlistDict, plistStringList, type PlistDict } from "./locked-use-plist.ts";

/** What ace expects to find when locked use is on. */
export interface LockedUseExpectation {
  /** CFBundleVersion of the bundle this ace ships. */
  bundleVersion: string;
  /** The pinned Developer ID team; without one, nothing can be proven valid. */
  team: string | undefined;
}

/**
 * One component as found: `absent` proven gone, `valid` proven ours and current, `invalid`
 * ours but wrong, `unknown` couldn't be read. Only `valid` ever counts toward `on`.
 */
export type ComponentFact =
  | { kind: "absent" }
  | { kind: "valid" }
  | { kind: "invalid"; reason: string }
  | { kind: "unknown"; reason: string };

export interface LockedUseFacts {
  bundle: ComponentFact;
  rule: ComponentFact;
  broker: ComponentFact;
  guardian: ComponentFact;
}

export interface LockedUseDetection {
  status: LockedUseStatus;
  facts: LockedUseFacts;
  /** True when anything of ours, or anything unreadable, may still be on this Mac. */
  residue: boolean;
}

const absent: ComponentFact = { kind: "absent" };
const valid: ComponentFact = { kind: "valid" };
const invalid = (reason: string): ComponentFact => ({ kind: "invalid", reason });
const unknown = (reason: string): ComponentFact => ({ kind: "unknown", reason });

/** `Key=value` lines from `codesign -dvv` (printed on stderr). */
export function codesignField(output: string, key: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0 && line.slice(0, index).trim() === key) {
      const value = line.slice(index + 1).trim();
      return value.length ? value : undefined;
    }
  }
  return undefined;
}

/** The string under `key` in an XML plist's root dict. */
export function plistValue(text: string, key: string): string | undefined {
  const value = parsePlistDict(text)?.get(key);
  return typeof value === "string" ? value.trim() : undefined;
}

/** What one `security authorizationdb read <right>` printed and how it exited. */
export interface RightRead {
  code: number;
  stdout: string;
  stderr: string;
}

type RightShape = { kind: "missing" } | { kind: "unreadable" } | { kind: "right"; dict: PlistDict };

/** errAuthorizationDenied: what `security authorizationdb read` prints for an undefined right. */
const undefinedRight = /\(-60005\)/;

function rightShape(read: RightRead): RightShape {
  if (read.code !== 0)
    return undefinedRight.test(`${read.stderr}\n${read.stdout}`)
      ? { kind: "missing" }
      : { kind: "unreadable" };
  const dict = parsePlistDict(read.stdout);
  return dict ? { kind: "right", dict } : { kind: "unreadable" };
}

const mentionsAce = (values: readonly string[]) =>
  values.some((value) => value === lockedUsePermitRight || value.includes("AceLockedUse"));

/**
 * The screen saver right: an OR rule (`class rule` with k-of-n 1, or a single name and no
 * k-of-n) that names our permit right.
 */
function screensaverShape(dict: PlistDict): "names" | "absent" | { invalid: string } {
  const rule = plistStringList(dict.get("rule"));
  // authd ignores `mechanisms` on a rule-class right; any ace entry there is stale, never valid.
  if (mentionsAce(plistStringList(dict.get("mechanisms"))))
    return { invalid: "The screen saver unlock rule has an ace entry macOS ignores." };
  const names = rule.includes(lockedUsePermitRight);
  if (!names)
    return mentionsAce(rule)
      ? { invalid: "The screen saver unlock rule has an unexpected ace entry." }
      : "absent";
  // An absent k-of-n means every name must succeed; it is an OR only with a single name.
  const kOfN = dict.get("k-of-n");
  const either = kOfN === 1 || (kOfN === undefined && rule.length === 1);
  if (dict.get("class") !== "rule" || !either)
    return { invalid: "The screen saver unlock rule isn't an either-or rule." };
  return "names";
}

/** Our permit right: `class evaluate-mechanisms` running our plug-in mechanism. */
function permitValid(dict: PlistDict): boolean {
  return (
    dict.get("class") === "evaluate-mechanisms" &&
    plistStringList(dict.get("mechanisms")).includes(lockedUseMechanism)
  );
}

/**
 * Whether the screen saver unlock rule reaches our mechanism, from two reads: the
 * `system.login.screensaver` right must be an OR rule naming `dev.ace.locked-use.permit`, and
 * that right must evaluate our mechanism. Only both together are valid; an unreadable read is
 * unknown, never valid.
 */
export function ruleFact(screensaver: RightRead, permit: RightRead): ComponentFact {
  const outer = rightShape(screensaver);
  if (outer.kind === "missing") return unknown("The screen saver unlock rule is missing.");
  if (outer.kind === "unreadable") return unknown("Couldn't read the screen saver unlock rule.");
  const named = screensaverShape(outer.dict);
  const inner = rightShape(permit);
  if (typeof named === "object") return invalid(named.invalid);
  if (named === "absent") {
    if (inner.kind === "missing") return absent;
    if (inner.kind === "unreadable") return unknown("Couldn't read ace's unlock right.");
    return invalid("ace's unlock right is defined but the screen saver rule doesn't name it.");
  }
  if (inner.kind === "missing")
    return invalid("The screen saver unlock rule names ace's unlock right, which is missing.");
  if (inner.kind === "unreadable") return unknown("Couldn't read ace's unlock right.");
  if (!permitValid(inner.dict)) return invalid("ace's unlock right doesn't run ace's plug-in.");
  return valid;
}

/** Whether `launchctl print system/<label>` shows the daemon loaded. 113 = not loaded. */
export function daemonFact(
  label: string,
  name: string,
  result: { code: number; stdout: string },
): ComponentFact {
  if (result.code === 113) return absent;
  if (result.code === 0 && result.stdout.includes(label)) return valid;
  return unknown(`Couldn't tell whether the ${name} is loaded.`);
}

async function plistVersion(host: MacHost, plist: string): Promise<string | undefined> {
  try {
    const text = await host.readText(plist);
    const version = plistValue(text, "CFBundleVersion");
    if (version !== undefined) return version;
  } catch {
    // Fall through to plutil, which also reads binary plists.
  }
  const result = await host.exec(plutilPath, [
    "-extract",
    "CFBundleVersion",
    "raw",
    "-o",
    "-",
    plist,
  ]);
  const version = result.stdout.trim();
  return result.code === 0 && /^[\w.-]{1,64}$/.test(version) ? version : undefined;
}

async function bundleFact(host: MacHost, expect: LockedUseExpectation): Promise<ComponentFact> {
  if (!(await host.fileExists(lockedUseBundlePath))) return absent;
  const verify = await host.exec(codesignPath, ["--verify", "--strict", lockedUseBundlePath]);
  if (verify.code !== 0) return invalid("The authorization plug-in's signature isn't valid.");
  const details = await host.exec(codesignPath, ["-dvv", lockedUseBundlePath]);
  if (details.code !== 0) return unknown("Couldn't read the authorization plug-in's signature.");
  const output = `${details.stderr}\n${details.stdout}`;
  if (codesignField(output, "Identifier") !== lockedUseBundleId)
    return invalid("The authorization plug-in isn't ace's.");
  if (!expect.team) return invalid("ace's signing team isn't configured on this build.");
  if (codesignField(output, "TeamIdentifier") !== expect.team)
    return invalid("The authorization plug-in is signed by a different team.");
  const version = await plistVersion(host, `${lockedUseBundlePath}/Contents/Info.plist`);
  if (version === undefined) return unknown("Couldn't read the authorization plug-in's version.");
  if (version !== expect.bundleVersion)
    return invalid("The authorization plug-in is a different version from this ace.");
  return valid;
}

/** Runs one reader; a host failure is unknown, never fatal and never valid. */
async function guard(read: () => Promise<ComponentFact>, what: string): Promise<ComponentFact> {
  try {
    return await read();
  } catch {
    return unknown(`Couldn't check the ${what}.`);
  }
}

/** Reads this Mac's facts: signed plug-in, rule alternative, both root daemons. Read-only. */
export async function readLockedUseFacts(
  host: MacHost,
  expect: LockedUseExpectation,
): Promise<LockedUseFacts> {
  const [bundle, rule, broker, guardian] = await Promise.all([
    guard(() => bundleFact(host, expect), "authorization plug-in"),
    guard(async () => {
      const [screensaver, permit] = await Promise.all([
        host.exec(securityPath, ["authorizationdb", "read", lockedUseRight]),
        host.exec(securityPath, ["authorizationdb", "read", lockedUsePermitRight]),
      ]);
      return ruleFact(screensaver, permit);
    }, "screen saver unlock rule"),
    guard(
      async () =>
        daemonFact(
          lockedUseBrokerLabel,
          "authorization service",
          await host.exec(launchctlPath, ["print", `system/${lockedUseBrokerLabel}`]),
        ),
      "authorization service",
    ),
    guard(
      async () =>
        daemonFact(
          lockedUseGuardianLabel,
          "relock guardian",
          await host.exec(launchctlPath, ["print", `system/${lockedUseGuardianLabel}`]),
        ),
      "relock guardian",
    ),
  ]);
  return { bundle, rule, broker, guardian };
}

const components = ["bundle", "rule", "broker", "guardian"] as const;

const missing: Record<keyof LockedUseFacts, string> = {
  bundle: "The authorization plug-in is missing.",
  rule: "The screen saver unlock rule doesn't include ace.",
  broker: "The authorization service isn't loaded.",
  guardian: "The relock guardian isn't loaded.",
};

/**
 * Maps facts to a status. `on` needs every component proven valid. Nothing present means
 * `off`, or `needsApproval` when the person has turned the setting on. Anything else is drift
 * with the first problem as its reason; an unreadable fact only reads as `off` when nothing
 * else is present and the setting is off.
 */
export function lockedUseStatusFromFacts(facts: LockedUseFacts, intent: boolean): LockedUseStatus {
  const entries = components.map((key) => [key, facts[key]] as const);
  if (entries.every(([, fact]) => fact.kind === "valid")) return { state: "on" };
  const present = entries.filter(([, fact]) => fact.kind === "valid" || fact.kind === "invalid");
  const unreadable = entries.filter(([, fact]) => fact.kind === "unknown");
  if (!present.length && !unreadable.length)
    return intent ? { state: "needsApproval" } : { state: "off" };
  if (!present.length && !intent) return { state: "off" };
  for (const [, fact] of entries)
    if (fact.kind === "invalid") return { state: "driftRepairNeeded", reason: fact.reason };
  for (const [, fact] of entries)
    if (fact.kind === "unknown") return { state: "driftRepairNeeded", reason: fact.reason };
  const gone = entries.find(([, fact]) => fact.kind === "absent");
  return {
    state: "driftRepairNeeded",
    reason: gone ? missing[gone[0]] : "Locked use isn't fully installed.",
  };
}

/** Whether anything of ours, or anything unreadable, may remain. */
export function hasResidue(facts: LockedUseFacts): boolean {
  return components.some((key) => facts[key].kind !== "absent");
}

/** Detects this Mac's locked-use status from read-only facts. Never throws. */
export async function detectLockedUse(
  host: MacHost,
  expect: LockedUseExpectation,
  intent: boolean,
): Promise<LockedUseDetection> {
  const facts = await readLockedUseFacts(host, expect);
  return { facts, status: lockedUseStatusFromFacts(facts, intent), residue: hasResidue(facts) };
}
