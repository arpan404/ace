import {
  mediaPipelineKeys,
  mediaPipelineState,
  mediaPipelineSwitch,
  mediaPipelineValue,
} from "@ace/ui-core";
import type { Writes } from "./settings-page-agents.ts";
import {
  lockedByEnvironment,
  pageSource,
  type PageRow,
  type ReadValues,
} from "./settings-page-wire.ts";

/*
 * Settings › Beta's new media pipeline switch on the phone: one toggle over `media.delivery`, read
 * and worded as web's Beta page does (`@ace/ui-core`). Turning it on or off writes that one
 * setting. Pure.
 */

/** The row's id, the same anchor web's Settings search uses. */
export const mediaPipelineRowId = "beta.mediaPipeline";

const locked = (values: ReadValues) =>
  mediaPipelineKeys.some((key) => values.get(key)?.provenance === "environment");

export function mediaPipelineRow(values: ReadValues): PageRow {
  const delivery = values.get("media.delivery");
  const { on } = mediaPipelineState(delivery?.value);
  return {
    id: mediaPipelineRowId,
    key: null,
    title: mediaPipelineSwitch.title,
    control: { kind: "toggle" },
    value: on,
    note: null,
    source: pageSource(delivery),
    locked: locked(values) ? lockedByEnvironment : null,
    empty: null,
  };
}

export function mediaPipelineWrite(values: ReadValues, raw: unknown): Writes {
  if (typeof raw !== "boolean")
    return { ok: false, message: `That isn't a choice for ${mediaPipelineSwitch.title}.` };
  if (locked(values)) return { ok: false, message: lockedByEnvironment };
  const value = mediaPipelineValue(raw);
  return { ok: true, writes: mediaPipelineKeys.map((key) => [key, value]) };
}
