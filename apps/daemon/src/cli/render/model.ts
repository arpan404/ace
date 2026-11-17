import type { ModelListResult } from "@ace/protocol";
import { columns } from "./provider-columns.ts";

/**
 * `ace model list` for a person: one model per line, grouped by provider in the catalogue's
 * order, its id first so it can be copied into `--model`. Pure.
 */
export function modelListLines(value: ModelListResult): string[] {
  if (!value.models.length) {
    const failing = value.instances.filter((instance) => instance.error);
    return failing.length
      ? failing.map(
          (instance) => `${instance.instance}: models couldn't be read (${instance.error}).`,
        )
      : ["No models yet. Check the providers with ace provider list."];
  }
  const rows = value.models.map((model) => [
    model.provider,
    model.id,
    model.displayName === model.id ? undefined : model.displayName,
    model.tier === "legacy" ? "older" : undefined,
  ]);
  const notes = value.instances
    .filter((instance) => instance.error || instance.stale)
    .map((instance) =>
      instance.error
        ? `${instance.instance}: couldn't refresh its models (${instance.error}).`
        : `${instance.instance}: models may be out of date.`,
    );
  const more =
    value.nextOffset === undefined ? [] : ["More models: pass --limit with a larger number."];
  return [...columns(rows), ...(notes.length || more.length ? ["", ...notes, ...more] : [])];
}

/** `--quiet`: the model ids, one per line. */
export function modelIds(value: ModelListResult): string[] {
  return value.models.map((model) => model.id);
}
