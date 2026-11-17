import type { Client } from "@ace/client";
import type { Args } from "../args.ts";
import type { Renderer } from "../io.ts";
import { CliFailure } from "../output.ts";
import { withSession, type CommandContext, type Handlers } from "./context.ts";

/** `ace automation …` (ADR 0176 §7). */

type Run = (args: Args, client: Client, signal: AbortSignal) => Promise<void>;

/** A mutation that was taken but couldn't be printed is uncertain, with its key to retry. */
async function mutationEmit<T extends { idempotencyKey: string }>(
  args: Args,
  value: T,
  render: Renderer<T>,
): Promise<void> {
  const { emit } = await import("../io.ts");
  try {
    await emit(args, value, render);
  } catch {
    throw new CliFailure("uncertain", "ace took it, but the answer couldn't be printed.", value, {
      code: "uncertain",
      idempotencyKey: value.idempotencyKey,
    });
  }
}

function session(run: Run) {
  return (context: CommandContext) =>
    withSession(context, context.args, ({ client, signal }) => run(context.args, client, signal));
}

const id = (args: Args) => args.words[0] ?? "";

export const automationHandlers: Handlers = {
  "automation.list": session(async (args, client, signal) => {
    const { listAutomations } = await import("../automations.ts");
    const { automationListLines } = await import("../render/automation.ts");
    const { emit } = await import("../io.ts");
    await emit(args, await listAutomations(client, signal), {
      human: automationListLines,
      quiet: (value) => (value.automations ?? []).map((automation) => automation.id),
    });
  }),
  "automation.show": session(async (args, client, signal) => {
    const { showAutomation } = await import("../automations.ts");
    const { automationLines } = await import("../render/automation.ts");
    const { emit } = await import("../io.ts");
    await emit(args, await showAutomation(client, signal, id(args)), {
      human: (value) =>
        value.automations?.[0] ? automationLines(value.automations[0], value.schedules?.[0]) : [],
      quiet: (value) => (value.automations ?? []).map((automation) => automation.id),
    });
  }),
  "automation.run": session(async (args, client, signal) => {
    const { runAutomation } = await import("../automations.ts");
    const { automationRunLines } = await import("../render/automation.ts");
    await mutationEmit(args, await runAutomation(args, client, signal, id(args)), {
      human: automationRunLines,
      quiet: (value) => (value.run?.threadId ? [value.run.threadId] : []),
    });
  }),
  "automation.create": session(async (args, client, signal) => {
    const { createAutomation } = await import("../automations.ts");
    await mutationEmit(args, await createAutomation(args, client, signal, id(args)), {
      human: (value) => [`Automation ${value.automationId} is saved.`],
      quiet: (value) => [value.automationId],
    });
  }),
  "automation.remove": session(async (args, client, signal) => {
    const { removeAutomation } = await import("../automations.ts");
    await mutationEmit(args, await removeAutomation(args, client, signal, id(args)), {
      human: (value) => [`Automation ${value.automationId} is removed.`],
      quiet: () => [],
    });
  }),
};
