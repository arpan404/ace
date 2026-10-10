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
  const params = new Map<string, string>();
  const defaults = model.serviceTiers.find((tier) => tier.id === model.defaultTier);
  for (const [key, value] of Object.entries(defaults?.parameters ?? {}))
    if (key !== "serviceTier" && typeof value === "string") params.set(key, value);
  const effort = options["effort"];
  if (typeof effort === "string") {
    if (!effortKey || !model.reasoningEfforts.includes(effort))
      throw new Error("Cursor model does not support this effort");
    params.set(effortKey, effort);
  }
  const tier = options["serviceTier"];
  if (tier !== undefined) {
    if (!entries.some(([key]) => key === "fast") || (tier !== "fast" && tier !== "default"))
      throw new Error("Cursor model does not support this speed");
    params.set("fast", tier === "fast" ? "true" : "false");
  }
  return CursorModelParams.parse([...params].map(([id, value]) => ({ id, value })));
}

/** Native parameters are persisted with their execution selection, never inferred from names. */
export function readCursorModelParams(options: ExecutionOptions | undefined) {
  const encoded = options?.["cursorModelParams"];
  if (encoded === undefined) return [];
  return CursorModelParams.parse(JSON.parse(z.string().max(8192).parse(encoded)));
}
