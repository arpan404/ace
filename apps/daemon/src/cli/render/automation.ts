import type { Automation, AutomationResponse, AutomationRun } from "@ace/protocol";

/** Words for `ace automation` (ADR 0178 §3). Pure: the daemon's answer → lines. */

type Schedule = NonNullable<AutomationResponse["schedules"]>[number];

function trigger(automation: Automation): string {
  const t = automation.trigger;
  switch (t.kind) {
    case "manual":
      return "by hand";
    case "schedule":
      return `${t.schedule.kind} ${t.schedule.expression}`;
    case "github":
      return `${t.repository} ${t.event.replaceAll("_", " ")}`;
    case "file":
      return `when ${t.paths.length === 1 ? t.paths[0] : `${t.paths.length} paths`} change`;
    case "webhook":
      return "webhook";
  }
}

function when(at: number): string {
  return new Date(at).toISOString().replace("T", " ").slice(0, 16);
}

const runGlyph: Readonly<Record<AutomationRun["status"], string>> = {
  queued: "◌",
  running: "◌",
  succeeded: "✓",
  failed: "✕",
  skipped: "-",
};

export function automationListLines(response: AutomationResponse): string[] {
  const automations = response.automations ?? [];
  if (!automations.length)
    return ["No automations yet. Make one in the app, or ace automation create @FILE."];
  const schedules = new Map((response.schedules ?? []).map((schedule) => [schedule.id, schedule]));
  const width = Math.min(32, Math.max(...automations.map((automation) => automation.title.length)));
  return automations.map((automation) => {
    const schedule = schedules.get(automation.id);
    const state = automation.enabled ? "" : "off  ";
    const next = schedule?.nextRunAt ? `  next ${when(schedule.nextRunAt)}` : "";
    const last = schedule?.lastRun
      ? `  ${runGlyph[schedule.lastRun.status]} ${schedule.lastRun.status}`
      : "";
    const problem = schedule?.triggerError || schedule?.lastPollError ? "  ✕ trigger failing" : "";
    return `${automation.title.padEnd(width)}  ${automation.id}  ${state}${trigger(automation)}${next}${last}${problem}`;
  });
}

export function automationLines(automation: Automation, schedule: Schedule | undefined): string[] {
  const lines = [
    `${automation.title}  ${automation.id}${automation.enabled ? "" : "  (off)"}`,
    `Runs         ${trigger(automation)}`,
    `In           ${automation.workspace}${automation.worktree ? ", in a worktree" : ""}`,
    `With         ${automation.provider}${automation.model ? ` ${automation.model}` : ""}`,
  ];
  if (schedule?.nextRunAt) lines.push(`Next run     ${when(schedule.nextRunAt)}`);
  const last = schedule?.lastRun;
  if (last)
    lines.push(
      `Last run     ${runGlyph[last.status]} ${last.status}, ${when(last.startedAt)}${last.threadId ? `, thread ${last.threadId}` : ""}`,
    );
  const error = schedule?.triggerError ?? schedule?.lastPollError;
  if (error) lines.push(`✕ ${error.message}`);
  if (schedule?.webhook?.url) lines.push(`Webhook      ${schedule.webhook.url}`);
  lines.push(
    "",
    automation.prompt.split("\n")[0] ?? "",
    "",
    `Run it now with ace automation run ${automation.id}`,
  );
  return lines;
}

export function automationRunLines(result: {
  automationId: string;
  run?: AutomationRun | undefined;
}) {
  const run = result.run;
  if (!run) return [`Automation ${result.automationId} was started.`];
  const thread = run.threadId ? ` in thread ${run.threadId}` : "";
  return [
    run.status === "queued"
      ? `Automation ${result.automationId} is queued behind its running one${thread}.`
      : `Automation ${result.automationId} is ${run.status}${thread}.`,
    ...(run.threadId ? [`Follow it with ace thread wait ${run.threadId}`] : []),
  ];
}
