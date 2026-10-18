import { z } from "zod";
import {
  AccessMode,
  AutomationSchedule,
  MessageText,
  ProviderKind,
  TriggerVariables,
} from "@ace/protocol";
import {
  NoData,
  controlResult,
  controlTool,
  controlToolTimeoutMs,
  fields,
} from "./control-tool.ts";

/**
 * Automations: saved prompts that run as child agents in this project, now or on a schedule.
 * Listing is a read; saving and running are ordinary actions under the provider's own mode;
 * only removing one deletes the person's saved work, so only that is destructive.
 */
const automations = {
  toolset: "ace-threads",
  timeoutMs: controlToolTimeoutMs,
  capability: "automations",
} as const;
const automationId = z
  .string()
  .min(1)
  .max(256)
  .describe("The automation's id, as you named it in automation_put.");

const automationsList = controlTool({
  ...automations,
  name: "automations_list",
  title: "List automations",
  riskClass: "read-only",
  capability: null,
  description:
    "Automations you or the threads you own created in this project, with each schedule's next run. runs: true reads recent runs instead, newest first, paged with before.",
  input: z.strictObject({
    runs: z.boolean().default(false).describe("Read recent runs instead of definitions."),
    automationId: automationId.optional().describe("runs: only this automation's runs."),
    before: z.number().int().positive().optional().describe("runs: the previous page's before."),
    limit: z.number().int().min(1).max(100).default(20).describe("runs: runs per page."),
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
  const keys = ["id", "title", "enabled", "provider", "model", "trigger"];
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
    "Create or replace an automation in this project: a prompt that runs as a child agent when run with automation_run, or on a schedule (RRULE or cron). Saving the same id again replaces it.",
  input: z.strictObject({
    id: automationId,
    title: z.string().min(1).max(256).describe("What it does, for the person's list."),
    prompt: MessageText.describe("The child's whole task, standing on its own."),
    schedule: AutomationSchedule.optional().describe(
      "Run on this schedule. kind rrule or cron; startAt in epoch ms, a whole minute. Omit for manual runs only.",
    ),
    enabled: z.boolean().default(true).describe("false saves it paused."),
    provider: ProviderKind.optional().describe("Default: yours."),
    model: z.string().min(1).max(256).optional().describe("A model id from `models`."),
    access: AccessMode.optional().describe("The child's access mode; default yours."),
    missedRun: z
      .enum(["skip", "run_once"])
      .default("skip")
      .describe("A schedule missed while ace was off: skip (default) or run once."),
  }),
  output: controlResult(z.unknown()),
  run: ({ schedule, ...automation }, control) =>
    control.run({
      op: "automation.manage",
      request: {
        type: "automation.put",
        requestId: `put:${automation.id}`,
        automation: {
          ...automation,
          trigger: schedule ? { kind: "schedule", schedule } : { kind: "manual" },
        },
      },
    }),
});

const automationRun = controlTool({
  ...automations,
  name: "automation_run",
  title: "Run an automation now",
  riskClass: "agent-execution",
  description:
    "Run a saved automation now, as a child agent. Its run appears in automations_list {runs: true} with the child's threadId.",
  input: z.strictObject({
    id: automationId,
    requestId: fields.requestId,
    variables: TriggerVariables.default({}).describe(
      "Values for {{name}} placeholders in its prompt.",
    ),
  }),
  output: controlResult(z.unknown()),
  run: ({ id, requestId, variables }, control) =>
    control.run({
      op: "automation.manage",
      request: { type: "automation.run", requestId, id, variables },
    }),
});

const automationRemove = controlTool({
  ...automations,
  name: "automation_remove",
  title: "Remove an automation",
  riskClass: "thread-write",
  destructive: true,
  description: "Delete a saved automation and its schedule. Past runs stay in the run list.",
  input: z.strictObject({ id: automationId }),
  output: NoData,
  run: ({ id }, control) =>
    control.run({
      op: "automation.manage",
      request: { type: "automation.remove", requestId: `remove:${id}`, id },
    }),
});

export const automationTools = [automationsList, automationPut, automationRun, automationRemove];
