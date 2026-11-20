import type { ModelInstance } from "./types.ts";

/**
 * What started a catalog refresh. `background`: restart, timers, version and setting changes,
 * and every `refresh`. `read`: a picker or `models` listing asked for the row. `request`: the
 * person asked for this row's models (Load models, `load`), from a socket that proved it is
 * theirs.
 */
export type RefreshCause = "background" | "read" | "request";

/** What the catalog knows of an ACP row when it decides whether a probe may start. */
export type AcpRowFacts = {
  /** The row has a model list now. */
  loaded: boolean;
  /**
   * The row loaded once in this run (the person's Load models, or a session of a thread they
   * started), so the agent already ran here with its own configuration.
   */
  loadedBefore: boolean;
  /** A `refresh` or sign-in reset the row: the next read may load it again, once. */
  due: boolean;
};

/**
 * Whether an ACP agent's row may open its metadata-only probe session now (ADR 0044, amendment
 * "models before the first thread"). The person's own request always may (the catalog still
 * spaces attempts, `AcpProbeSpacing`). A read may only for a reviewed profile, and only to load
 * again a row that loaded before and is empty or reset: an agent starts the MCP servers its own
 * configuration names when a session opens, which ace cannot turn off, so the first start is
 * the person's. Startup, timers and `refresh` never probe.
 */
export function acpProbeAllowed(
  config: Pick<ModelInstance, "modelProbe">,
  facts: AcpRowFacts,
  cause: RefreshCause,
): boolean {
  if (!config.modelProbe) return false;
  if (cause === "request") return true;
  return (
    cause === "read" &&
    config.modelProbe === "automatic" &&
    facts.loadedBefore &&
    (!facts.loaded || facts.due)
  );
}

/**
 * How the row reports its probe: a reviewed agent that has not loaded yet in this run waits for
 * the person like an unprofiled one, so the picker offers Load models.
 */
export function reportedProbe(
  config: Pick<ModelInstance, "modelProbe">,
  loadedBefore: boolean,
): ModelInstance["modelProbe"] {
  return config.modelProbe === "automatic" && !loadedBefore ? "on-request" : config.modelProbe;
}

/**
 * The earliest each ACP row's next probe may start: one per `intervalMs`, whatever asked for it,
 * so neither repeated Load models nor reset-and-read loops start an agent again and again. Kept
 * by row id, through re-registration (a login or version change), and bounded by the rows.
 */
export class AcpProbeSpacing {
  readonly #startedAt = new Map<string, number>();
  readonly #intervalMs: number;
  constructor(intervalMs: number) {
    if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error("Invalid probe interval");
    this.#intervalMs = intervalMs;
  }
  /** Whether a probe of `id` may start at `now`; when it may, it counts as started. */
  admit(id: string, now: number): boolean {
    const last = this.#startedAt.get(id);
    if (last !== undefined && now - last < this.#intervalMs) return false;
    this.#startedAt.set(id, now);
    return true;
  }
  forget(id: string): void {
    this.#startedAt.delete(id);
  }
}
