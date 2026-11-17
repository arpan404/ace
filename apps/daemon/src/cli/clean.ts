import { readFile } from "node:fs/promises";
import type { StoragePlan } from "@ace/protocol";
import type { Client } from "@ace/client";
import type { Args } from "./args.ts";
import { emit, type Renderer } from "./io.ts";
import { outputMode } from "./input-mode.ts";
import { CliFailure, exitCodes, type Outcome } from "./output.ts";
import { planOperation } from "./clean-options.ts";
import { applyCleanup, applyOutcome, planCleanup } from "./retention-request.ts";
import { confirmQuestion, planLines, receiptLine, reviewLines } from "./render/storage.ts";

export interface Confirmation {
  /** Whether a person can answer on this terminal. */
  interactive: boolean;
  ask(question: string, signal: AbortSignal): Promise<boolean>;
}

/** The person at this terminal, asked with the CLI's prompts; `interactive` says whether one is. */
export function terminalConfirmation(interactive: boolean): Confirmation {
  return {
    interactive,
    async ask(question) {
      const { askConfirm } = await import("./ask.ts");
      return askConfirm(question);
    },
  };
}

/**
 * Prints a mutation's result and sets its exit code. A result that was taken but couldn't be
 * printed is uncertain, with the evidence to read it again.
 */
export async function printResult<T>(
  args: Args,
  value: T,
  render: Renderer<T>,
  outcome: Outcome,
  evidence: unknown = value,
): Promise<void> {
  try {
    await emit(args, value, render);
  } catch {
    throw new CliFailure("uncertain", "The result couldn't be printed.", evidence, {
      code: "uncertain",
      hint: "Read where it stands with ace storage status PLAN.",
    });
  }
  process.exitCode = exitCodes[outcome];
}

export function printPlan(args: Args, plan: StoragePlan): Promise<void> {
  return printResult(args, plan, { human: reviewLines, quiet: (value) => [value.id] }, "ok");
}

/**
 * `ace storage clean` (`ace clean`): plan, show the plan, then apply that exact plan and
 * revision once the person says yes. Off a terminal it needs `--yes`, and refuses before
 * planning without it, so an unattended run never removes anything without consent.
 */
export async function cleanCommand(
  args: Args,
  client: Client,
  signal: AbortSignal,
  confirmation: Confirmation,
): Promise<void> {
  const operation = await planOperation(args, (path) => readFile(path, "utf8"));
  // Forcing protected items is reviewed as a preview first, then applied with `storage apply`.
  if (operation.forceItems.length && !args.flags["dry-run"])
    throw new CliFailure(
      "refused",
      "--force-item needs --dry-run first. Nothing was removed.",
      undefined,
      {
        code: "refused",
        hint: "Review the plan with --dry-run, then apply it with ace storage apply PLAN --revision R.",
      },
    );
  if (args.flags["dry-run"]) return printPlan(args, await planCleanup(client, operation, signal));
  if (!args.flags.yes && !confirmation.interactive)
    throw new CliFailure(
      "refused",
      "Pass --yes to clean without a terminal, or --dry-run to preview. Nothing was removed.",
      undefined,
      { code: "confirm" },
    );
  const plan = await planCleanup(client, operation, signal);
  const human = outputMode(args.flags) === "human";
  const removable = plan.items.some((item) => item.disposition === "remove");
  if (human) await emit(args, plan, { human: planLines });
  if (!removable) {
    await emit(args, { plan, apply: null }, { human: () => "Nothing to remove.", quiet: () => [] });
    return;
  }
  if (!args.flags.yes) {
    if (!human) process.stderr.write(`${planLines(plan).join("\n")}\n`);
    // An aborted or cancelled prompt is a refusal: no apply was sent.
    const confirmed = await confirmation.ask(confirmQuestion(plan), signal).catch(() => false);
    if (!confirmed)
      throw new CliFailure("refused", "Cleanup cancelled. Nothing was removed.", undefined, {
        code: "refused",
      });
  }
  const receipt = await applyCleanup(client, { planId: plan.id, revision: plan.revision }, signal);
  await printResult(
    args,
    { plan, apply: receipt },
    { human: (value) => receiptLine(value.apply), quiet: () => [] },
    applyOutcome(receipt),
    receipt,
  );
}
