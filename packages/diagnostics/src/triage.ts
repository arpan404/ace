import { z } from "zod";
import type { LogDigest } from "./triage-logs.ts";

export type { LogDigest } from "./triage-logs.ts";
export { digestLogLines } from "./triage-logs.ts";
export { triagePlaybook } from "./triage-playbook.ts";

/** CLI-only: triage never crosses the wire, so this lives here, not in @ace/protocol. */
export const TriageProvider = z.enum(["claude", "codex", "cursor", "opencode"]);
export type TriageProvider = z.infer<typeof TriageProvider>;

export type TriageProviderEntry = {
  value: TriageProvider;
  label: string;
  /** Executable names in preference order. */
  commands: readonly string[];
};
export const triageProviders: readonly TriageProviderEntry[] = [
  { value: "claude", label: "Claude Code", commands: ["claude"] },
  { value: "codex", label: "Codex", commands: ["codex"] },
  // `agent` is generic; only fall back to it when cursor-agent is missing.
  { value: "cursor", label: "Cursor CLI", commands: ["cursor-agent", "agent"] },
  { value: "opencode", label: "OpenCode", commands: ["opencode"] },
];

/** Machine facts for the agent. Everything is optional and already redacted. */
export type TriageFacts = {
  /** ISO time the facts were collected. */
  collectedAt: string;
  cliVersion: string;
  os: string;
  node: string;
  /** How this `ace` was started: the script path tells app bundle from source checkout. */
  launchedFrom: string;
  daemon?: "running" | "stopped";
  clis: readonly { label: string; version?: string }[];
  paths: {
    data: string;
    log: string;
    settings: string;
    databases: readonly string[];
    sourceCache: string;
  };
  /** Never to be opened: tokens, certificates, account logins, browser profiles. */
  secrets: readonly string[];
  logs: readonly LogDigest[];
  /** Doctor findings that are not ok, when triage started from `ace doctor`. */
  findings?: readonly { id: string; status: string; message: string }[];
  /** Probes that failed while collecting. In a broken install these are clues. */
  problems: readonly string[];
  /** Milliseconds since epoch, for aging log entries. */
  now: number;
};

/** The facts file the playbook points at. Plain Markdown, no prose instructions. */
export function buildTriageFacts(facts: TriageFacts): string {
  const lines = [
    "# ace triage facts",
    "",
    `Collected by \`ace triage\` at ${facts.collectedAt}.`,
    "",
    `- ace CLI version: ${facts.cliVersion} (the \`ace\` that ran triage; the problem may be on another build)`,
    `- OS: ${facts.os}`,
    `- Node: ${facts.node}`,
    `- CLI launched from: ${facts.launchedFrom}`,
    `- ace daemon: ${facts.daemon ?? "unknown"}`,
    `- Agent CLIs: ${
      facts.clis.length
        ? facts.clis
            .map((cli) => (cli.version ? `${cli.label} ${cli.version}` : cli.label))
            .join(", ")
        : "none found"
    }`,
    "- Source: https://github.com/arpan404/ace (release tags look like v0.0.4)",
    "",
    "## Paths",
    "",
    `- ace data folder: ${facts.paths.data}`,
    `- Log (JSON lines; also \`ace logs --limit 200\`): ${facts.paths.log}`,
    `- Settings: ${facts.paths.settings}`,
    `- Databases (SQLite, live; read only unless the person agrees): ${
      facts.paths.databases.length ? facts.paths.databases.join(", ") : "none found"
    }`,
    `- Source cache (clone ace here): ${facts.paths.sourceCache}`,
    `- Never open: ${facts.secrets.join(", ")}`,
  ];
  if (facts.findings?.length)
    lines.push(
      "",
      "## Open ace doctor findings",
      "",
      ...facts.findings.map(
        (finding) =>
          `- ${finding.status.toUpperCase()} ${finding.id}: ${finding.message.slice(0, 200)}`,
      ),
    );
  lines.push("", "## Recent warnings and errors (last 24 hours)", "");
  lines.push(
    ...(facts.logs.length
      ? facts.logs.map(
          (entry) =>
            `- ${entry.count > 1 ? `${entry.count}× ` : ""}${entry.level} ${entry.component}: ${entry.message} (last ${age(facts.now - entry.lastAt)} ago)` +
            (entry.sample ? `\n  ${entry.sample}` : ""),
        )
      : ["None."]),
  );
  if (facts.problems.length)
    lines.push("", "## Couldn't check", "", ...facts.problems.map((problem) => `- ${problem}`));
  return lines.join("\n") + "\n";
}

/** One short line, so it survives any shell or argv limit. The detail lives in files. */
export function triageLaunchLine(playbookPath: string): string {
  return `Read ${playbookPath} and follow it. It is your ace triage playbook; start by asking me what went wrong.`;
}

/** Arguments are passed directly to the executable, never interpreted by a shell. */
export function triageInvocation(provider: TriageProvider, prompt: string): string[] {
  // OpenCode treats a positional as its start directory; the prompt needs its flag.
  // The `=` form keeps a prompt that begins with `-` from reading as another flag.
  return provider === "opencode" ? [`--prompt=${prompt}`] : ["--", prompt];
}

function age(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}
