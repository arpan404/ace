import { StorageKind, StorageRequest, StorageRetention } from "@ace/protocol";
import { z } from "zod";
import { option, type Args } from "./args.ts";
import { CliFailure } from "./output.ts";

export type PlanOperation = Extract<StorageRequest["operation"], { op: "cleanup.plan" }>;
/** Each kind is selectable as its own switch, e.g. `--logs --worktrees`. */
export const kindSwitches: readonly StorageKind[] = StorageKind.options;
export const planOptions = ["kinds", "retention", "force-items", "older-than", ...kindSwitches];

/** Pure translation of `clean`/`storage plan` options into one daemon plan request. */
export function planOperation(args: Args): PlanOperation {
  const switched = kindSwitches.filter((kind) => args.flags[kind] === true);
  const listed = option(args, "kinds");
  if (switched.length && listed !== undefined)
    throw new CliFailure("refused", "Use either kind switches or --kinds, not both");
  const kinds = switched.length
    ? switched
    : listed !== undefined
      ? z.array(StorageKind).min(1).max(6).parse(listed.split(","))
      : undefined;
  const olderThan = option(args, "older-than");
  const saved = option(args, "retention");
  if (olderThan !== undefined && saved !== undefined)
    throw new CliFailure("refused", "Use either --older-than or --retention, not both");
  const retention =
    olderThan !== undefined
      ? retentionFor(kinds ?? kindSwitches, olderThanDays(olderThan))
      : saved !== undefined
        ? StorageRetention.parse(JSON.parse(saved))
        : undefined;
  return {
    op: "cleanup.plan",
    ...(kinds ? { kinds } : {}),
    ...(retention ? { retention } : {}),
    forceItems: z
      .array(z.string().min(1).max(256))
      .max(256)
      .parse(JSON.parse(option(args, "force-items") ?? "[]")),
  };
}

export function olderThanDays(value: string): number {
  const days = /^(\d{1,5})d$/.exec(value)?.[1];
  const parsed = days === undefined ? Number.NaN : Number.parseInt(days, 10);
  if (!(parsed >= 1 && parsed <= 36500))
    throw new CliFailure("refused", "--older-than takes whole days from 1d to 36500d, e.g. 30d");
  return parsed;
}

/** Unselected kinds are disabled (null) so an age threshold never widens the selection. */
function retentionFor(kinds: readonly StorageKind[], days: number): StorageRetention {
  const retention = StorageRetention.parse({});
  for (const kind of kindSwitches) retention[kind] = kinds.includes(kind) ? days : null;
  return retention;
}
