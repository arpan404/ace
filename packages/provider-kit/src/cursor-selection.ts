import { z } from "zod";
import type { CatalogModel, ExecutionOptions } from "@ace/protocol";
/** Legacy selections refer to the single SDK default, never the editor's home. */
export const cursorDefaultInstanceId = "cursor-sdk-default";
export function cursorInstanceId(id: string | undefined): string | undefined {
  return id === "cursor-cli-default" ? cursorDefaultInstanceId : id;
}

export const CursorModelParams = z
  .array(
    z.strictObject({
      id: z.string().min(1).max(256),
      value: z.string().max(256),
    }),
  )
  .max(16);

/** Compile account-reported Cursor parameters; UI effort/speed names are not SDK ids. */
export function cursorModelParams(model: CatalogModel, options: ExecutionOptions) {
  const entries = model.serviceTiers.flatMap((tier) => Object.entries(tier.parameters));
  let effortKey = ["reasoning_effort", "effort", "reasoning"].find((key) =>
    entries.some(([id]) => id === key),
  );
  if (!effortKey && !model.raw.truncated) {
    try {
      const metadata = z
        .object({
          parameters: z
            .array(z.object({ id: z.string() }))
            .max(32)
            .optional(),
        })
        .parse(JSON.parse(model.raw.json));
      effortKey = metadata.parameters?.find((parameter) =>
        ["reasoning_effort", "effort", "reasoning"].includes(parameter.id),
      )?.id;
    } catch {
      /* Optional raw metadata cannot override the validated catalog. */
    }
  }
  const chosen = new Map<string, string>();
  const effort = options["effort"];
  if (typeof effort === "string") {
    if (!effortKey || !model.efforts.some((entry) => entry.id === effort))
      throw new Error("Cursor model does not support this effort");
    chosen.set(effortKey, effort);
  }
  const tier = options["serviceTier"];
  if (tier !== undefined) {
    if (!entries.some(([key]) => key === "fast") || (tier !== "fast" && tier !== "default"))
      throw new Error("Cursor model does not support this speed");
    chosen.set("fast", tier === "fast" ? "true" : "false");
  }
  const defaults = nativeParams(model.serviceTiers.find((entry) => entry.id === model.defaultTier));
  const variant = advertisedVariant(model, chosen, defaults);
  // No listed variant carries the choice: keep the default's other values and apply it.
  const params = variant ?? new Map([...defaults, ...chosen]);
  return CursorModelParams.parse([...params].map(([id, value]) => ({ id, value })));
}

type Tier = CatalogModel["serviceTiers"][number];
function nativeParams(tier: Tier | undefined) {
  const params = new Map<string, string>();
  for (const [key, value] of Object.entries(tier?.parameters ?? {}))
    if (key !== "serviceTier" && typeof value === "string") params.set(key, value);
  return params;
}

/**
 * The SDK forwards `params` as-is and Cursor rejects any combination it doesn't list
 * ("Invalid parameters for registry model"). Send one listed variant whole.
 *
 * The SDK's default variant is often the large-context (Max Mode) one: 500k for Grok 4.7,
 * 1m for Claude and GPT. Local SDK runs can't ask for Max Mode, and Cursor refuses the
 * large context without it, so the standard (smallest) context wins over the default.
 */
function advertisedVariant(
  model: CatalogModel,
  chosen: ReadonlyMap<string, string>,
  defaults: ReadonlyMap<string, string>,
) {
  // Without a listed default there is nothing to tell full variants from UI hints.
  if (!defaults.size) return undefined;
  let best: { params: Map<string, string>; rank: number[] } | undefined;
  for (const tier of model.serviceTiers) {
    const params = nativeParams(tier);
    if (![...chosen].every(([key, value]) => params.get(key) === value)) continue;
    // A full variant names every parameter the default does; partial tiers are UI hints.
    if (![...defaults.keys()].every((key) => params.has(key))) continue;
    const agreeing = [...defaults].filter(([key, value]) => params.get(key) === value).length;
    const rank = [-(contextTokens(params.get("context")) ?? Infinity), agreeing];
    if (!best || isGreater(rank, best.rank)) best = { params, rank };
  }
  return best?.params;
}

function isGreater(left: number[], right: number[]) {
  const index = left.findIndex((value, position) => value !== right[position]);
  return index >= 0 && (left[index] ?? 0) > (right[index] ?? 0);
}

/** "256k" → 256000, "1m" → 1000000. Unknown spellings don't affect the choice. */
export function contextTokens(value: string | undefined) {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)\s*([km]?)$/i);
  if (!match?.[1]) return undefined;
  const unit = match[2]?.toLowerCase();
  return Number(match[1]) * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1);
}

/** Native parameters are persisted with their execution selection, never inferred from names. */
export function readCursorModelParams(options: ExecutionOptions | undefined) {
  const encoded = options?.["cursorModelParams"];
  if (encoded === undefined) return [];
  return CursorModelParams.parse(JSON.parse(z.string().max(8192).parse(encoded)));
}
