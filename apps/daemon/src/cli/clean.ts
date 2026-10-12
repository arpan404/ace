import { createInterface } from "node:readline/promises";
import type { StorageApply, StoragePlan } from "@ace/protocol";
import type { Client } from "@ace/client";
import { option, validateArgs, type Args } from "./args.ts";
import { print, result, mutationResult } from "./io.ts";
import { CliFailure } from "./output.ts";
import { planOperation, planOptions } from "./clean-options.ts";
import { applyCleanup, applyOutcome, planCleanup, type ApplyReceipt } from "./retention-request.ts";

export interface Confirmation {
  /** Whether a person can answer on this terminal. */
  interactive: boolean;
  ask(question: string, signal: AbortSignal): Promise<boolean>;
}
export function terminalConfirmation(): Confirmation {
  return {
    interactive: process.stdin.isTTY === true,
    async ask(question, signal) {
      const reader = createInterface({ input: process.stdin, output: process.stderr });
      // End of input (Ctrl-D) answers no rather than leaving the prompt pending.
      const closed = new Promise<string>((resolve) => reader.once("close", () => resolve("")));
      try {
        const answer = await Promise.race([reader.question(question, { signal }), closed]);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        reader.close();
      }
    },
  };
}

/** `ace clean`: plan, show the plan, then apply that exact plan and revision once confirmed. */
export async function cleanCommand(
  args: Args,
  client: Client,
  signal: AbortSignal,
  confirmation: Confirmation,
) {
  validateArgs(args, [...planOptions, "dry-run", "yes"], 1);
  const operation = planOperation(args);
  // Forcing protected items is reviewed as a preview first, then applied with `clean apply`.
  if (operation.forceItems.length && !args.flags["dry-run"])
    throw new CliFailure("refused", "--force-items requires --dry-run. Nothing was removed.");
  if (args.flags["dry-run"]) {
    await printPlan(args, await planCleanup(client, operation, signal));
    return;
  }
  // Refuse before planning: an unattended run never removes anything without explicit consent.
  if (!args.flags.yes && !confirmation.interactive)
    throw new CliFailure(
      "refused",
      "Pass --yes to clean without a terminal, or --dry-run to preview. Nothing was removed.",
    );
  const plan = await planCleanup(client, operation, signal);
  const json = !!args.flags.json || option(args, "jq") !== undefined;
  const removable = plan.items.filter((item) => item.disposition === "remove");
  if (!json) await print(args, planSummary(plan));
  if (!removable.length) {
    await result(args, json ? { plan, apply: null } : "Nothing to remove.");
    return;
  }
  if (!args.flags.yes) {
    if (json) process.stderr.write(`${planSummary(plan)}\n`);
    const question = `Remove ${removable.length} item${removable.length === 1 ? "" : "s"} (${formatBytes(plan.bytes)})? [y/N] `;
    // An aborted prompt (interrupt, timeout, closed input) is a refusal: no apply was sent.
    const confirmed = await confirmation.ask(question, signal).catch(() => false);
    if (!confirmed) throw new CliFailure("refused", "Cleanup cancelled. Nothing was removed.");
  }
  const receipt = await applyCleanup(client, { planId: plan.id, revision: plan.revision }, signal);
  await printReceipt(args, json ? { plan, apply: receipt } : receiptSummary(receipt), receipt);
}

export async function printPlan(args: Args, plan: StoragePlan) {
  const json = !!args.flags.json || option(args, "jq") !== undefined;
  await mutationResult(
    args,
    json
      ? plan
      : `${planSummary(plan)}\nApply with: ace clean apply ${plan.id} --revision ${plan.revision}`,
  );
}

/** A receipt that could not be printed still names the plan to read or apply again. */
export async function printReceipt(args: Args, value: unknown, receipt: StorageApply) {
  try {
    await result(args, value, applyOutcome(receipt));
  } catch {
    throw new CliFailure(
      "uncertain",
      "Cleanup result could not be printed. Read the recorded plan status.",
      receipt,
    );
  }
}

export function planSummary(plan: StoragePlan): string {
  const remove = plan.items.filter((item) => item.disposition === "remove");
  const keep = plan.items.filter((item) => item.disposition === "protect");
  const lines = [`Plan ${plan.id} (revision ${plan.revision})`];
  lines.push(`Remove ${remove.length} item(s), ${formatBytes(plan.bytes)}:`);
  for (const item of remove)
    lines.push(`  ${item.kind.padEnd(11)} ${item.label}  ${formatBytes(item.bytes)}`);
  if (keep.length) lines.push(`Keep ${keep.length} item(s):`);
  for (const item of keep)
    lines.push(`  ${item.kind.padEnd(11)} ${item.label}  ${item.reasons.join(", ")}`);
  if (!plan.complete) lines.push("Inventory is incomplete; run clean again after this batch.");
  return lines.join("\n");
}

function receiptSummary(receipt: ApplyReceipt): string {
  const count = (state: string) => receipt.items.filter((item) => item.state === state).length;
  return `Cleanup ${receipt.state}: ${count("removed")} removed, ${count("protected")} kept, ${count("pending")} pending (plan ${receipt.planId}, revision ${receipt.revision}).`;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
}
