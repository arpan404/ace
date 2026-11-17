import { StorageKind, StorageRequest, StorageRetention } from "@ace/protocol";
import { z } from "zod";
import { option, type Args } from "./args.ts";
import { usageFailure } from "./output.ts";

export type PlanOperation = Extract<StorageRequest["operation"], { op: "cleanup.plan" }>;
/** Each kind is selectable as its own switch, e.g. `--logs --worktrees`. */
export const kindSwitches: readonly StorageKind[] = StorageKind.options;

const ForcedItems = z.array(z.string().min(1).max(256)).max(256);

/**
 * `storage plan` and `storage clean` flags as one daemon plan request (ADR 0176 §8):
 * `--force-item ID` repeated and `--retention @FILE`. The first CLI's JSON forms
 * (`--force-items '["id"]'`, `--retention '{…}'`, `--kinds a,b`) still work in the window.
 * `readFile` is the only effect; everything else is pure.
 */
export async function planOperation(
  args: Args,
  readFile: (path: string) => Promise<string>,
): Promise<PlanOperation> {
  const switched = kindSwitches.filter((kind) => args.flags[kind] === true);
  const listed = option(args, "kinds");
  if (switched.length && listed !== undefined)
    throw usageFailure("Use either kind switches or --kinds, not both.", {
      argument: "--kinds",
      hint: "Pass the kinds as switches, like --logs --worktrees.",
    });
  const kinds = switched.length ? switched : listed !== undefined ? kindList(listed) : undefined;
  const olderThan = option(args, "older-than");
  const retentionFlag = option(args, "retention");
  if (olderThan !== undefined && retentionFlag !== undefined)
    throw usageFailure("Use either --older-than or --retention, not both.", {
      argument: "--older-than",
    });
  // An explicit selection keeps a threshold from re-enabling kinds disabled in settings.
  if (olderThan !== undefined && !kinds)
    throw usageFailure("--older-than needs at least one kind.", {
      argument: "--older-than",
      hint: "Name what to clean, like ace storage clean --logs --older-than 30d.",
    });
  const retention =
    olderThan !== undefined && kinds
      ? retentionFor(kinds, olderThanDays(olderThan))
      : retentionFlag !== undefined
        ? parseRetention(await jsonFlag("--retention", retentionFlag, readFile))
        : undefined;
  return {
    op: "cleanup.plan",
    ...(kinds ? { kinds } : {}),
    ...(retention ? { retention } : {}),
    forceItems: forcedItems(args),
  };
}

function kindList(listed: string): StorageKind[] {
  const parsed = z.array(StorageKind).min(1).max(6).safeParse(listed.split(","));
  if (parsed.success) return parsed.data;
  throw usageFailure(`--kinds takes ${kindSwitches.join(", ")}, comma-separated.`, {
    argument: "--kinds",
  });
}

/** `--force-item ID`, repeated, or the old `--force-items JSON`; never both. */
function forcedItems(args: Args): string[] {
  const repeated = args.lists?.["force-item"] ?? [];
  const old = option(args, "force-items");
  if (repeated.length && old !== undefined)
    throw usageFailure("Use --force-item ID, not both it and --force-items.", {
      argument: "--force-items",
    });
  let items: unknown = repeated;
  if (old !== undefined)
    try {
      items = JSON.parse(old);
    } catch {
      throw usageFailure("--force-items takes a JSON list of item ids.", {
        argument: "--force-items",
        hint: "Pass each one as --force-item ID instead.",
      });
    }
  const parsed = ForcedItems.safeParse(items);
  if (parsed.success) return parsed.data;
  throw usageFailure("--force-item takes an item id from the plan, at most 256 of them.", {
    argument: "--force-item",
  });
}

/** `@FILE` reads JSON from a file; anything else is the first CLI's inline JSON. */
async function jsonFlag(
  flag: string,
  value: string,
  readFile: (path: string) => Promise<string>,
): Promise<unknown> {
  const path = value.startsWith("@") ? value.slice(1) : undefined;
  let text = value;
  if (path !== undefined)
    try {
      text = await readFile(path);
    } catch {
      throw usageFailure(`Couldn't read ${path} for ${flag}.`, {
        argument: flag,
        hint: `Pass ${flag} @FILE with the path of a JSON file.`,
      });
    }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw usageFailure(`${flag} needs JSON${path ? `, and ${path} isn't` : ""}.`, {
      argument: flag,
      hint: `Write the retention as JSON in a file and pass ${flag} @FILE.`,
    });
  }
}

function parseRetention(value: unknown): StorageRetention {
  const parsed = StorageRetention.safeParse(value);
  if (parsed.success) return parsed.data;
  throw usageFailure('--retention must give days per kind, like {"logs": 14}, or null to keep.', {
    argument: "--retention",
    hint: `Kinds: ${kindSwitches.join(", ")}.`,
  });
}

export function olderThanDays(value: string): number {
  const days = /^(\d{1,5})d$/.exec(value)?.[1];
  const parsed = days === undefined ? Number.NaN : Number.parseInt(days, 10);
  if (!(parsed >= 1 && parsed <= 36500))
    throw usageFailure("--older-than takes whole days from 1d to 36500d, like 30d.", {
      argument: "--older-than",
    });
  return parsed;
}

/** Unselected kinds are disabled (null) so an age threshold never widens the selection. */
function retentionFor(kinds: readonly StorageKind[], days: number): StorageRetention {
  const retention = StorageRetention.parse({});
  for (const kind of kindSwitches) retention[kind] = kinds.includes(kind) ? days : null;
  return retention;
}
