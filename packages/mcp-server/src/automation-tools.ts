import { z } from "zod";
import { AgentAutomationSchedule, MessageText, TriggerVariables } from "@ace/protocol";
import {
  NoData,
  controlResult,
  controlTool,
  controlToolTimeoutMs,
  fields,
} from "./control-tool.ts";

/**
 * Automations: saved messages sent into your own thread, now or on a schedule.
 * Listing is a read; saving and running are ordinary actions under the provider's own mode;
 * only removing one deletes the person's saved work, so only that is destructive.
 */
const automations = {
  toolset: "ace-threads",
  timeoutMs: controlToolTimeoutMs,
  capability: "automations",
} as const;
const automationId = z.string().min(1).max(256).describe("The id you gave it in automation_put.");

const automationsList = controlTool({
  ...automations,
  name: "automations_list",
  title: "List automations",
  riskClass: "read-only",
  capability: null,
  description:
    "Automations you or your threads created in this project, with each next run. runs: true reads recent runs instead, newest first, paged with before.",
  input: z.strictObject({
    runs: z.boolean().default(false),
    automationId: automationId.optional().describe("runs: only this one's."),
    before: z.number().int().positive().optional().describe("runs: the previous page's before."),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  output: controlResult(z.unknown()),
  async run({ runs, automationId: id, before, limit }, control) {
    if (runs)
      return control.run({
        op: "automation.manage",
        request: {
          type: "automation.inbox",
          requestId: "list-runs",
          limit,
          ...(before ? { before } : {}),
          ...(id ? { automationId: id } : {}),
        },
      });
    const listed = await control.run({
      op: "automation.manage",
      request: { type: "automation.list", requestId: "list" },
    });
    const definitions = z.array(z.record(z.string(), z.unknown())).safeParse(listed.data);
    return definitions.success
      ? { ...listed, data: { automations: definitions.data.map(summary) } }
      : listed;
  },
});

/** What an agent needs of a definition to recognise, run or replace it. */
function summary(automation: Record<string, unknown>) {
  const keys = ["id", "title", "enabled", "trigger", "nextRunAt", "lastRun"];
  return Object.fromEntries(
    keys.flatMap((key) => (automation[key] === undefined ? [] : [[key, automation[key]]])),
  );
}

const automationPut = controlTool({
  ...automations,
  name: "automation_put",
  title: "Save an automation",
  riskClass: "agent-execution",
  description:
    "Create or replace (same id) an automation: a message ace sends into this thread on a schedule or with automation_run. You answer it here with this thread's model and access, queued behind any running turn.",
  input: z.strictObject({
    id: automationId,
    title: z.string().min(1).max(256).describe("What it does, for the person."),
    prompt: MessageText.describe(
      "The message each run sends: the whole task, readable without this conversation.",
    ),
    schedule: AgentAutomationSchedule.optional().describe(
      "rrule (FREQ=DAILY;BYHOUR=9;BYMINUTE=0) or cron (0 9 * * 1-5); timezone defaults to this machine's, startAt (epoch ms, whole minute) to now. Omit to run by hand only.",
    ),
    enabled: z.boolean().default(true).describe("false saves it paused."),
    missedRun: z
      .enum(["skip", "run_once"])
      .default("skip")
      .describe("A run missed while ace was off: skip it, or run once."),
  }),
  output: controlResult(z.unknown()),
  async run({ schedule, ...automation }, control) {
    const saved = await control.run({
      op: "automation.manage",
      request: {
        type: "automation.put",
        requestId: `put:${automation.id}`,
        automation: {
          ...automation,
          trigger: schedule ? { kind: "schedule", schedule } : { kind: "manual" },
        },
      },
    });
    if (saved.ok === false) return saved;
    // What was saved, as automations_list shows it: its trigger and when it runs next.
    const listed = await control.run({
      op: "automation.manage",
      request: { type: "automation.list", requestId: `put-read:${automation.id}` },
    });
    const definitions = z.array(z.record(z.string(), z.unknown())).safeParse(listed.data);
    const entry = definitions.success
      ? definitions.data.find((candidate) => candidate["id"] === automation.id)
      : undefined;
    return entry ? { ...saved, data: { automation: summary(entry) } } : saved;
  },
});

/**
 * Run, pause and resume share one tool: they carry the same risk, and the catalogue stays inside
 * its budget (mcp-agent-budget.process.test.ts). Removing deletes the person's work, so it stays
 * its own destructive tool.
 */
const automationRun = controlTool({
  ...automations,
  name: "automation_run",
  title: "Run, pause or resume an automation",
  riskClass: "agent-execution",
  description:
    "Run a saved automation now (action run): its message arrives here after any running turn, and the run shows in automations_list {runs: true}. pause skips a waiting run and stops a running one; resume restarts its schedule from now.",
  input: z
    .strictObject({
      id: automationId,
      action: z.enum(["run", "pause", "resume"]).default("run"),
      requestId: fields.requestId.optional().describe("run: any stable id; a repeat runs once."),
      variables: TriggerVariables.default({}).describe("run: values for {{name}} in its prompt."),
    })
    .superRefine((input, context) => {
      if (input.action === "run" && input.requestId === undefined)
        context.addIssue({ code: "custom", path: ["requestId"], message: "run needs requestId." });
    })
    .meta({ "x-ace-constraint": "run needs requestId." }),
  output: controlResult(z.unknown()),
  run: ({ id, action, requestId, variables }, control) =>
    action === "run"
      ? control.run({
          op: "automation.manage",
          request: { type: "automation.run", requestId: requestId ?? "", id, variables },
        })
      : control.run({
          op: "automation.manage",
          request: {
            type: "automation.setEnabled",
            requestId: `${action}:${id}`,
            id,
            enabled: action === "resume",
          },
        }),
});

const automationRemove = controlTool({
  ...automations,
  name: "automation_remove",
  title: "Remove an automation",
  riskClass: "thread-write",
  destructive: true,
  description: "Delete a saved automation and its schedule; past runs stay listed.",
  input: z.strictObject({ id: automationId }),
  output: NoData,
  run: ({ id }, control) =>
    control.run({
      op: "automation.manage",
      request: { type: "automation.remove", requestId: `remove:${id}`, id },
    }),
});

export const automationTools = [automationsList, automationPut, automationRun, automationRemove];
