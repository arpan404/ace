import type { ModelFilter } from "@ace/protocol";
import type { ModelInstance } from "./types.ts";

/**
 * What started a catalog refresh. `background`: restart, timers, version and setting changes.
 * `read`: a picker or `models` listing asked for the row. `request`: the person asked for this
 * row's models (Refresh, Load models).
 */
export type RefreshCause = "background" | "read" | "request";

/**
 * Whether an ACP agent's row may open its metadata-only probe session now (ADR 0044, amendment
 * "models before the first thread"). A reviewed profile probes once, on the first read of a row
 * that has never loaded; after that its sessions keep the row current. An unprofiled agent
 * probes only when the person asks. Startup and timers never probe.
 */
export function acpProbeAllowed(
  config: Pick<ModelInstance, "modelProbe">,
  loaded: boolean,
  cause: RefreshCause,
): boolean {
  if (!config.modelProbe) return false;
  if (cause === "request") return true;
  return cause === "read" && config.modelProbe === "automatic" && !loaded;
}

/**
 * A `refresh` names an unprofiled agent's row only when the filter picks that row itself: a
 * refresh of every model, or every ACP agent, is no request to start that agent.
 */
export function refreshCause(config: ModelInstance, filter: ModelFilter): RefreshCause {
  return config.modelProbe === "on-request" && filter.instance !== config.id
    ? "background"
    : "request";
}
