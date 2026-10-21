import type { DiagnosticReport, TriageKind, TriageProvider } from "@ace/protocol";

/** Portable prompt policy for the terminal wizard. No machine reads. */
export const triageTemplates: readonly { value: TriageKind; label: string; instruction: string }[] =
  [
    {
      value: "bug",
      label: "Report a bug",
      instruction:
        "Investigate this ace bug. Confirm reproduction steps, find the cause and fix it.",
    },
    {
      value: "feature",
      label: "Request a feature",
      instruction:
        "Implement this ace feature. Check the existing code and clarify acceptance criteria before making changes.",
    },
    {
      value: "performance",
      label: "Investigate performance",
      instruction:
        "Investigate this ace performance problem. Reproduce it, measure the affected path and distinguish provider latency from ace overhead.",
    },
    {
      value: "doctor",
      label: "Fix my ace setup",
      instruction:
        "Resolve the ace setup findings below. Check which optional tools are needed before installing anything. Preserve existing data and rerun affected checks after repair.",
    },
  ];
export const triageProviders: readonly { value: TriageProvider; label: string; command: string }[] =
  [
    { value: "claude", label: "Claude Code", command: "claude" },
    { value: "codex", label: "Codex", command: "codex" },
    { value: "cursor", label: "Cursor CLI", command: "agent" },
  ];
export function buildTriagePrompt(input: {
  kind: TriageKind;
  description: string;
  report?: DiagnosticReport;
  environment?: string;
}): string {
  const template = triageTemplates.find((entry) => entry.value === input.kind);
  if (!template) throw new Error("Unknown triage template");
  const description = input.description.trim();
  if (!description || description.length > 16_000)
    throw new Error("Describe the issue in 1–16,000 characters.");
  const sections = [
    "# ace triage",
    template.instruction,
    "## User description\n" + description,
    "Follow AGENTS.md and relevant architecture decisions. Verify the result. Ask before deleting data or publishing an issue.",
  ];
  if (input.environment) sections.push("## Environment\n" + input.environment.slice(0, 1024));
  if (input.report) {
    const findings = input.report.checks.filter((check) => check.status !== "ok");
    const passed = input.report.checks.length - findings.length;
    sections.push(
      "## ace doctor results\n" +
        [
          ...findings.map(
            (check) =>
              `- ${check.status.toUpperCase()} ${check.id}: ${check.message.slice(0, 200)}${check.fix ? `\n  Next: ${check.fix.slice(0, 200)}` : ""}`,
          ),
          `${passed} ${passed === 1 ? "check" : "checks"} passed.`,
        ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

/** Arguments are passed directly to the executable, never interpreted by a shell. */
export function triageInvocation(provider: TriageProvider, prompt: string) {
  const entry = triageProviders.find((candidate) => candidate.value === provider);
  if (!entry) throw new Error("Unknown triage provider");
  return { command: entry.command, args: ["--", prompt] };
}
