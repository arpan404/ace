import type {
  DeviceScope,
  MachineInstall,
  MachineUpdate,
  MachineUpdateAsk,
  MachineUpdateBlock,
  MachineUpdateOutcome,
  MachineUpdateRequest,
} from "@ace/protocol";

/*
 * Remote updates, decided (ADR 0113). Pure: the coordinator gathers the facts and carries out
 * the step. Nothing here reads a clock, a file or a process.
 */

/** Where the installer has got, as it reports it. */
export type InstallerPhase = "none" | "available" | "downloading" | "ready" | "installing";

/** What an installer (the desktop app, the standalone updater) says about this machine. */
export interface InstallerFacts {
  /** The release on offer for this platform, when one is newer. */
  available: string | null;
  releaseUrl: string | null;
  blocked: MachineUpdateBlock | null;
  phase: InstallerPhase;
  percent: number | null;
  /** The installer's last error, in words for the person. */
  error: string | null;
  checkedAt: number | null;
  /** True when the release is downloaded before installing (the desktop app); the standalone
   * updater downloads as part of installing. */
  downloadsFirst: boolean;
}

/** An install this daemon started and hasn't seen end yet; kept across the restart. */
export interface Installing {
  from: string;
  to: string;
  mode: "idle" | "now";
  at: number;
}

export type Step =
  | { kind: "none" }
  | { kind: "download" }
  | { kind: "install"; mode: "idle" | "now" }
  | { kind: "expire"; error: string };

/** Blocks a request can never get past, whatever happens later. */
const lasting = new Set<string>(["release-page", "source"]);

/**
 * The next thing to do for `ask`. An install already under way is left alone. A request for a
 * release that is no longer the one on offer expires. Otherwise: download first when the
 * installer does, install now when asked, or install when idle once nothing works or waits on a
 * person.
 */
export function nextStep(input: {
  ask: MachineUpdateAsk | null;
  facts: InstallerFacts;
  busy: number;
  installing: Installing | null;
}): Step {
  const { ask, facts, busy, installing } = input;
  if (!ask || installing || facts.phase === "installing") return { kind: "none" };
  if (facts.blocked && lasting.has(facts.blocked))
    return { kind: "expire", error: "This install updates from its release page." };
  // No offer yet: the app hasn't reported, or the feed hasn't answered. Keep waiting.
  if (facts.available === null) return { kind: "none" };
  if (facts.available !== ask.version)
    return {
      kind: "expire",
      error: `${facts.available} is out now, so the update to ${ask.version} was dropped. Update again to get ${facts.available}.`,
    };
  if (facts.blocked) return { kind: "none" };
  if (facts.downloadsFirst) {
    if (facts.phase === "available") return { kind: "download" };
    if (facts.phase !== "ready") return { kind: "none" };
  }
  const mode = ask.mode === "now" ? "now" : "idle";
  if (mode === "now" || busy === 0) return { kind: "install", mode };
  return { kind: "none" };
}

export type StartRefusal = "blocked" | "stale" | "confirm" | "invalid";

/**
 * Whether a start may be accepted. A request names the release the person saw, so a newer one
 * found meanwhile is never installed unseen. `now` names how many working agents the person
 * confirmed stopping; more working now means they haven't seen them all.
 */
export function startRefusal(input: {
  request: Pick<MachineUpdateRequest, "mode" | "version" | "agents">;
  facts: InstallerFacts;
  busy: number;
}): StartRefusal | undefined {
  const { request, facts, busy } = input;
  if (!request.mode || !request.version) return "invalid";
  if (facts.blocked) return "blocked";
  if (facts.available === null || facts.available !== request.version) return "stale";
  if (request.mode === "now" && busy > (request.agents ?? 0)) return "confirm";
  return undefined;
}

/** Reading needs read scope; checking, starting and cancelling need an administrator. */
export function requiredScope(operation: MachineUpdateRequest["operation"]): DeviceScope {
  return operation === "status" ? "read" : "admin";
}

/**
 * How an install that was under way when this daemon started ended. The running version is the
 * truth: the target means it worked. Otherwise the updater's outcome says why, or nothing did.
 */
export function settleInstall(input: {
  installing: Installing;
  running: string;
  outcome: { ok: boolean; error: string | null; busy?: boolean | undefined } | undefined;
  at: number;
}): { last: MachineUpdateOutcome; retry: boolean } {
  const { installing, running, outcome, at } = input;
  const base = { from: installing.from, to: installing.to, at };
  if (running === installing.to) return { last: { ...base, ok: true, error: null }, retry: false };
  // Work started meanwhile and outlasted the drain: an update when idle waits for the next idle.
  if (outcome?.busy && installing.mode === "idle")
    return { last: { ...base, ok: false, error: outcome.error }, retry: true };
  return {
    last: {
      ...base,
      ok: false,
      error:
        outcome?.error ??
        `The update to ${installing.to} didn't finish. ace ${running} is still running.`,
    },
    retry: false,
  };
}

/** The status a client reads, from the facts and what this daemon holds. */
export function machineStatus(input: {
  version: string;
  platform: string;
  arch: string;
  install: MachineInstall;
  facts: InstallerFacts;
  ask: MachineUpdateAsk | null;
  installing: Installing | null;
  last: MachineUpdateOutcome | null;
  busy: number;
}): MachineUpdate {
  const { facts, ask, installing, last, busy } = input;
  const failed = last && !last.ok && !ask ? last : null;
  return {
    version: input.version,
    platform: input.platform,
    arch: input.arch,
    install: input.install,
    state: state(input),
    available: facts.available,
    releaseUrl: facts.releaseUrl,
    blocked: facts.blocked,
    ask,
    busy,
    percent: facts.phase === "downloading" ? facts.percent : null,
    error: failed?.error ?? (installing ? null : facts.error),
    last,
    checkedAt: facts.checkedAt,
  };
}

function state(input: Parameters<typeof machineStatus>[0]): MachineUpdate["state"] {
  const { facts, ask, installing, last, busy, version } = input;
  if (installing || facts.phase === "installing") return "installing";
  if (ask) {
    if (facts.phase === "downloading") return "downloading";
    if (ask.mode === "idle" && busy > 0) return "waiting";
    if (facts.downloadsFirst && facts.phase === "ready") return "ready";
    return "waiting";
  }
  if (last && !last.ok && facts.available === last.to) return "failed";
  if (facts.phase === "downloading") return "downloading";
  if (facts.phase === "ready") return "ready";
  if (facts.available) return "available";
  if (last?.ok && last.to === version) return "updated";
  return "none";
}
