/*
 * The ACP registry as people browse it: search, what each entry means for this computer, an
 * install plan in plain words, install progress and fixed, friendly failure copy. Pure over
 * @ace/protocol's registry types, so web and mobile say the same thing.
 */
import type {
  RegistryAgent,
  RegistryInstallation,
  RegistryInstallPlan,
  RegistryInstallProgress,
} from "@ace/protocol";
import { formatAgo } from "./time.ts";

/** "Google", "Anthropic, Zed Industries": the authors without their email addresses. */
export function registryPublisher(authors: readonly string[]): string {
  return authors
    .map((author) => author.replace(/<[^>]*>/g, "").trim())
    .filter(
      (name) =>
        name &&
        !name.includes("@") &&
        !/[\d_]/.test(name) &&
        (/\s/.test(name) || /[A-Z]/.test(name)),
    )
    .join(", ");
}

const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);

/** How well an entry matches every query word; higher is better, null when one word misses. */
function score(agent: RegistryAgent, query: readonly string[]): number | null {
  const name = agent.name.toLowerCase();
  const publisher = registryPublisher(agent.authors).toLowerCase();
  const description = agent.description.toLowerCase();
  const id = agent.acpAgentId.toLowerCase();
  let total = 0;
  for (const word of query) {
    if (name.startsWith(word)) total += 40;
    else if (name.split(/[^\p{L}\p{N}]+/u).some((part) => part.startsWith(word))) total += 30;
    else if (name.includes(word) || id.includes(word)) total += 20;
    else if (publisher.includes(word)) total += 10;
    else if (description.includes(word)) total += 1;
    else return null;
  }
  return total;
}

/**
 * The entries matching `query` by name, publisher, id or description: every word must match
 * somewhere, name matches first. An empty query keeps the registry's order.
 */
export function searchRegistry(
  agents: readonly RegistryAgent[],
  query: string,
): readonly RegistryAgent[] {
  const terms = words(query);
  if (terms.length === 0) return agents;
  return agents
    .map((agent, index) => ({ agent, index, score: score(agent, terms) }))
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .toSorted((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.agent);
}

/** Dotted versions compared numerically ("1.10.0" after "1.9.2"); non-numbers compare as 0. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

/** What an entry is to this computer: installed (maybe behind), installable, or not. */
export type RegistryStanding =
  | { kind: "installed"; version: string; update?: string | undefined }
  | { kind: "available" }
  | { kind: "unavailable"; reason: string };

/** The newest installation of an agent, if any. */
export function latestInstallation(
  acpAgentId: string,
  installations: readonly RegistryInstallation[],
): RegistryInstallation | undefined {
  return installations
    .filter((entry) => entry.acpAgentId === acpAgentId)
    .toSorted((a, b) => compareVersions(b.version, a.version))[0];
}

export function registryStanding(
  agent: RegistryAgent,
  installations: readonly RegistryInstallation[],
): RegistryStanding {
  const installed = latestInstallation(agent.acpAgentId, installations);
  if (installed)
    return {
      kind: "installed",
      version: installed.version,
      update:
        agent.availability === "available" && compareVersions(agent.version, installed.version) > 0
          ? agent.version
          : undefined,
    };
  if (agent.availability === "unsupported_target")
    return { kind: "unavailable", reason: "Not built for this computer" };
  if (agent.availability === "unsupported_distribution")
    return { kind: "unavailable", reason: "Ships in a format ace can't install" };
  return { kind: "available" };
}

/** "Updated 5m ago", or that the registry hasn't been read yet. */
export function registryAge(fetchedAt: number | undefined, now: number): string {
  return fetchedAt === undefined ? "Not downloaded yet" : `Updated ${formatAgo(fetchedAt, now)}`;
}

const platforms: Record<string, string> = {
  "darwin-aarch64": "macOS on Apple silicon",
  "darwin-x86_64": "macOS on Intel",
  "linux-aarch64": "Linux on Arm",
  "linux-x86_64": "Linux on x64",
  "windows-aarch64": "Windows on Arm",
  "windows-x86_64": "Windows on x64",
};

/** One argument as a shell would need it typed. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The exact command an install plan runs: the package manager, or the installed binary. */
export function planCommand(plan: RegistryInstallPlan): string {
  if (plan.runtime !== "binary") return plan.argv.map(shellWord).join(" ");
  const [, entrypoint = "", ...args] = plan.argv;
  const path = `${plan.destination}/${entrypoint.replace(/^\.\//, "")}`;
  return [path, ...args].map(shellWord).join(" ");
}

/** A plan fact: what it is, in words, and whether it's a path or command (monospaced). */
export interface PlanFact {
  label: string;
  value: string;
  code?: boolean;
}

/** An install plan as people review it before saying yes: what, from where, how, and checks. */
export function planFacts(plan: RegistryInstallPlan, name: string): PlanFact[] {
  const spec = plan.argv.at(-1) ?? "";
  const source =
    plan.runtime === "binary"
      ? URL.canParse(plan.argv[0] ?? "")
        ? `Download from ${new URL(plan.argv[0] ?? "").host}`
        : "Download"
      : plan.runtime === "npm"
        ? `npm package ${spec}`
        : `Python package ${spec}`;
  const runtime =
    plan.runtime === "binary"
      ? `Prebuilt binary for ${platforms[plan.target] ?? plan.target}`
      : plan.runtime === "npm"
        ? "npm, with your Node.js"
        : "uv, with your Python";
  const checks =
    plan.verification === "sha256"
      ? "SHA-256 checksum from the registry, before unpacking"
      : plan.verification === "package_manager"
        ? plan.runtime === "npm"
          ? "npm records the package's integrity"
          : "uv records the package; no checksum"
        : "HTTPS only; the registry gives no checksum";
  const publisher = registryPublisher(plan.publisher);
  const command = planCommand(plan);
  return [
    { label: "Installs", value: `${name} ${plan.version}${publisher ? ` by ${publisher}` : ""}` },
    { label: "From", value: source },
    { label: "Runtime", value: runtime },
    { label: "Verified by", value: checks },
    ...(command.includes(plan.destination)
      ? []
      : [{ label: "Location", value: plan.destination, code: true }]),
    {
      label: plan.runtime === "binary" ? "ace runs" : "ace runs to install",
      value: command,
      code: true,
    },
  ];
}

/** "Downloading", "Installing with npm": an install's current step, in words. */
export function installPhase(
  progress: Pick<RegistryInstallProgress, "phase">,
  runtime: RegistryInstallPlan["runtime"],
): string {
  switch (progress.phase) {
    case "preparing":
      return "Preparing";
    case "download":
      return "Downloading";
    case "extract":
      return "Unpacking";
    case "package_manager":
      return `Installing with ${runtime === "uv" ? "uv" : "npm"}`;
    case "persist":
      return "Finishing";
  }
}

/** Every refusal the daemon's registry gives, as fixed words a person can act on. */
const failures: readonly [RegExp, string][] = [
  [/^Installation cancelled/, "Installation cancelled. Nothing was changed."],
  [
    /^Installation failed/,
    "The install didn't finish. Agents you already have still work; try again.",
  ],
  [
    /plan changed or expired/,
    "The registry changed while you were reviewing. Check the new plan and install again.",
  ],
  [/^Another installation/, "Another agent is installing. Try again once it finishes."],
  [/^Refresh the registry/, "Refresh the registry, then try again."],
  [/^Select a local package manager/, "ace couldn't find the package manager this agent needs."],
  [/^Agent registry unavailable/, "This daemon can't install from the ACP registry yet."],
  [/unavailable$/, "This agent isn't available for this computer."],
  [/not pinned/, "This entry doesn't pin an exact version, so ace won't install it."],
  [/^Unsupported archive/, "This agent ships in a format ace can't install."],
  [
    /^Unsafe artifact|escapes destination/,
    "This entry's files are unsafe, so ace won't install it.",
  ],
  [/^Artifact must use HTTPS/, "This entry doesn't download over HTTPS, so ace won't install it."],
  [/private account environment/, "This entry asks for account settings ace never applies."],
  [/scope required$/, "This device can't install agents. Use the computer running ace."],
  [/^Too many registry requests/, "ace is busy. Try again in a moment."],
];

/** A registry failure in fixed, friendly words; never the daemon's raw reason. */
export function registryFailure(reason: string): string {
  return failures.find(([pattern]) => pattern.test(reason))?.[1] ?? "That didn't work. Try again.";
}

/** "G", "CA": up to two initials for an entry without an icon. */
export function monogram(name: string): string {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = parts.length > 1 ? parts.slice(0, 2).map((part) => part[0]) : [name[0]];
  return letters.join("").toUpperCase();
}

/**
 * How to set an agent up after installing it, from the registry's login hint: a command to run
 * in a terminal (and what to type at its prompt), or the hint as a note when it isn't one.
 * ace never signs ACP agents in itself (ADR 0002); each uses its own CLI's login.
 */
export function registrySetup(loginHint: string): { run?: string; prompt?: string; note?: string } {
  const command = /^[a-z0-9][\w.-]*(?: [a-z0-9][\w.-]*)*$/;
  const [, run, prompt] = /^(.+?), then (\/\S+)$/.exec(loginHint) ?? [];
  if (run && prompt && command.test(run)) return { run, prompt };
  const [, head, note] = /^([^:]+): (.+)$/.exec(loginHint) ?? [];
  if (head && note && command.test(head)) return { run: head, note };
  return command.test(loginHint) ? { run: loginHint } : { note: loginHint };
}
