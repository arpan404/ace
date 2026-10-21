import type { DiagnosticReport } from "@ace/protocol";
import { z } from "zod";
import type { LogDigest } from "./triage-logs.ts";

export type { LogDigest } from "./triage-logs.ts";
export { digestLogLines } from "./triage-logs.ts";

/** CLI-only: triage never crosses the wire, so these live here, not in @ace/protocol. */
export const TriageKind = z.enum(["bug", "feature", "performance", "doctor"]);
export type TriageKind = z.infer<typeof TriageKind>;
export const TriageProvider = z.enum(["claude", "codex", "cursor", "opencode"]);
export type TriageProvider = z.infer<typeof TriageProvider>;

type Question = { message: string; placeholder: string; heading: string };
export type TriageTemplate = {
  value: TriageKind;
  label: string;
  hint: string;
  goal: string;
  steps: readonly string[];
  /** The main question. Required, except for setup where the doctor report speaks first. */
  ask: Question & { required: boolean };
  /** One optional follow-up that makes the handoff sharper. */
  followUp: Question;
};

/** Portable prompt policy for the terminal wizard. No machine reads. */
export const triageTemplates: readonly TriageTemplate[] = [
  {
    value: "bug",
    label: "Report a bug",
    hint: "attaches recent ace errors",
    goal: "Find and fix the cause of this ace bug.",
    steps: [
      "Reproduce it, or explain why you can't.",
      "Check the recent warnings and errors above, and the ace logs around the same time.",
      "Find the root cause before changing anything, then fix it and show how you verified the fix.",
    ],
    ask: {
      message: "What went wrong?",
      placeholder: "I clicked Stop and the thread kept showing Working…",
      heading: "What happened",
      required: true,
    },
    followUp: {
      message: "What did you expect instead? (optional)",
      placeholder: "The thread should stop within a second",
      heading: "Expected",
    },
  },
  {
    value: "feature",
    label: "Request a feature",
    hint: "turns an idea into a plan",
    goal: "Design and build this ace feature.",
    steps: [
      "Read the code it touches and say which parts change.",
      "Agree the acceptance criteria with me before writing code.",
      "Build it in small steps and verify each one.",
    ],
    ask: {
      message: "What should ace do?",
      placeholder: "Filter the sidebar by project",
      heading: "Request",
      required: true,
    },
    followUp: {
      message: "How will you know it's done? (optional)",
      placeholder: "The filter survives a reload and keeps the selected thread",
      heading: "Done when",
    },
  },
  {
    value: "performance",
    label: "Investigate performance",
    hint: "measures before it fixes",
    goal: "Find out why this part of ace is slow and make it faster.",
    steps: [
      "Reproduce it and measure the slow path before changing anything.",
      "Separate provider or network latency from time spent in ace.",
      "Fix the largest cost first and report before and after numbers.",
    ],
    ask: {
      message: "What feels slow?",
      placeholder: "Switching threads",
      heading: "Slow path",
      required: true,
    },
    followUp: {
      message: "How slow, and how often? (optional)",
      placeholder: "About 4 seconds, every time with long threads",
      heading: "Observed",
    },
  },
  {
    value: "doctor",
    label: "Fix my ace setup",
    hint: "runs ace doctor first",
    goal: "Fix the ace setup problems found by ace doctor below.",
    steps: [
      "Ask which optional tools I need before installing anything.",
      "Fix one finding at a time and preserve existing data.",
      "Run ace doctor again after each fix.",
    ],
    ask: {
      message: "Anything else to mention? (optional)",
      placeholder: "Codex stopped appearing after I updated it",
      heading: "Notes",
      required: false,
    },
    followUp: {
      message: "When did it start? (optional)",
      placeholder: "After updating macOS",
      heading: "Started",
    },
  },
];

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

/** What the wizard found on this computer. Every part is optional and already redacted. */
export type TriageContext = {
  environment?: string;
  daemon?: "running" | "stopped";
  clis?: readonly { label: string; version?: string }[];
  dataDir?: string;
  logFile?: string;
  logs?: readonly LogDigest[];
  /** Milliseconds since epoch, used to age log entries. */
  now?: number;
  /** Probes that failed. In a broken install these are often the best evidence. */
  problems?: readonly string[];
};

export function triageTemplate(kind: TriageKind): TriageTemplate {
  const template = triageTemplates.find((entry) => entry.value === kind);
  if (!template) throw new Error("Unknown triage template");
  return template;
}

export function buildTriagePrompt(input: {
  kind: TriageKind;
  description: string;
  followUp?: string;
  report?: DiagnosticReport;
  context?: TriageContext;
}): string {
  const template = triageTemplate(input.kind);
  const description = input.description.trim();
  const followUp = input.followUp?.trim() ?? "";
  if (template.ask.required && !description)
    throw new Error("Describe the issue in 1–16,000 characters.");
  if (description.length + followUp.length > 16_000)
    throw new Error("Describe the issue in 1–16,000 characters.");
  const context = input.context ?? {};
  const sections = [template.goal];
  if (description) sections.push(`## ${template.ask.heading}\n${description}`);
  if (followUp) sections.push(`## ${template.followUp.heading}\n${followUp}`);
  if (input.report) sections.push(doctorSection(input.report));
  if (context.logs?.length) sections.push(logSection(context.logs, context.now));
  const environment = environmentSection(context);
  if (environment) sections.push(environment);
  if (context.problems?.length)
    sections.push(
      "## Couldn't check\nThese failed while collecting this prompt. Treat them as clues.\n" +
        context.problems.map((problem) => `- ${problem}`).join("\n"),
    );
  sections.push(lookSection(context));
  sections.push(
    "## How to work\n" +
      template.steps.map((step, index) => `${index + 1}. ${step}`).join("\n") +
      "\nIf this is the ace source repository, follow AGENTS.md. If the cause is in ace itself and you can't change its code here, draft a GitHub issue for arpan404/ace with the evidence and show it to me before filing.\nAsk before deleting data, changing ace settings or publishing anything.",
  );
  return sections.join("\n\n");
}

function doctorSection(report: DiagnosticReport): string {
  const findings = report.checks.filter((check) => check.status !== "ok");
  const passed = report.checks.length - findings.length;
  return (
    "## ace doctor\n" +
    [
      ...findings.map(
        (check) =>
          `- ${check.status.toUpperCase()} ${check.id}: ${check.message.slice(0, 200)}${check.fix ? `\n  Next: ${check.fix.slice(0, 200)}` : ""}`,
      ),
      `${passed} ${passed === 1 ? "check" : "checks"} passed.`,
    ].join("\n")
  );
}

function logSection(logs: readonly LogDigest[], now: number | undefined): string {
  return (
    "## Recent ace warnings and errors (last 24 hours)\n" +
    logs
      .map(
        (entry) =>
          `- ${entry.count > 1 ? `${entry.count}× ` : ""}${entry.level} ${entry.component}: ${entry.message}` +
          (now === undefined ? "" : ` (last ${age(now - entry.lastAt)} ago)`) +
          (entry.sample ? `\n  ${entry.sample}` : ""),
      )
      .join("\n")
  );
}

function environmentSection(context: TriageContext): string | undefined {
  const lines = [
    context.environment?.slice(0, 1024),
    context.daemon && `ace daemon: ${context.daemon}`,
    context.clis &&
      `Agent CLIs: ${
        context.clis.length
          ? context.clis
              .map((cli) => (cli.version ? `${cli.label} ${cli.version}` : cli.label))
              .join(", ")
          : "none found"
      }`,
  ].filter((line): line is string => !!line);
  return lines.length ? "## Environment\n" + lines.join("\n") : undefined;
}

function lookSection(context: TriageContext): string {
  return [
    "## Where to look",
    `- Logs: ${context.logFile ? `${context.logFile} (JSON lines), or ` : ""}\`ace logs --limit 200\``,
    "- Health: `ace doctor --json`",
    context.dataDir
      ? `- Data: ${context.dataDir}. Its SQLite files are live; read them, never write to them.`
      : "- Data: read ace's SQLite files, never write to them.",
  ].join("\n");
}

function age(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

/** Arguments are passed directly to the executable, never interpreted by a shell. */
export function triageInvocation(provider: TriageProvider, prompt: string): string[] {
  // OpenCode treats a positional as its start directory; the prompt needs its flag.
  // The `=` form keeps a prompt that begins with `-` from reading as another flag.
  return provider === "opencode" ? [`--prompt=${prompt}`] : ["--", prompt];
}
