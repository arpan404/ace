import type { FromMedia } from "./wire.ts";

/**
 * The daemon's store of what ace-media runs on (ADR 0148): the probe's capability list, from
 * `ready` and replaced whole by each `capabilities.changed`, and each source's
 * `source.status.acceleration`, kept under the daemon's own name for the source (a producer's
 * `source`), not ace-media's id for one open, so a source keeps its report across reopens. The
 * degraded rule is ace-media's (`acceleration.rs`); the daemon only keeps and hands on what it
 * said. Everything is forgotten when ace-media exits: a report from a process that is gone
 * would claim a path nothing runs.
 */

export type MediaCapabilityEntry = Extract<FromMedia, { type: "ready" }>["capabilities"][number];
export type SourceAcceleration = NonNullable<
  Extract<FromMedia, { type: "source.status" }>["acceleration"]
>;

/** What changed: the capability list, or one source's report. */
export type AccelerationChange = { kind: "capabilities" } | { kind: "source"; source: string };

export class MediaAccelerationStore {
  #capabilities: readonly MediaCapabilityEntry[] | undefined;
  readonly #sources = new Map<string, SourceAcceleration>();
  readonly #listeners = new Set<(change: AccelerationChange) => void>();

  /** The probe's list from the running ace-media; undefined before `ready` and after it exits. */
  capabilities(): readonly MediaCapabilityEntry[] | undefined {
    return this.#capabilities;
  }

  /** The source's steps, once ace-media has chosen them. */
  of(source: string): SourceAcceleration | undefined {
    return this.#sources.get(source);
  }

  /** Every source with a report, by the daemon's name. */
  sources(): ReadonlyMap<string, SourceAcceleration> {
    return this.#sources;
  }

  /** Told after each change; returns the unsubscribe. */
  watch(listener: (change: AccelerationChange) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /** ace-media's messages: `ready` and `capabilities.changed` carry the whole list. */
  message(message: FromMedia): void {
    if (message.type !== "ready" && message.type !== "capabilities.changed") return;
    this.#capabilities = message.capabilities;
    this.#emit({ kind: "capabilities" });
  }

  /** A source's report, or undefined once nothing in ace-media runs it any more. */
  report(source: string, acceleration: SourceAcceleration | undefined): void {
    const before = this.#sources.get(source);
    if (acceleration === undefined) {
      if (!before) return;
      this.#sources.delete(source);
    } else {
      if (before && same(before, acceleration)) return;
      this.#sources.set(source, acceleration);
    }
    this.#emit({ kind: "source", source });
  }

  /** ace-media exited: its list and every report are gone with it. */
  exited(): void {
    const reported = [...this.#sources.keys()];
    this.#sources.clear();
    for (const source of reported) this.#emit({ kind: "source", source });
    if (this.#capabilities === undefined) return;
    this.#capabilities = undefined;
    this.#emit({ kind: "capabilities" });
  }

  #emit(change: AccelerationChange): void {
    for (const listener of this.#listeners) listener(change);
  }
}

function same(a: SourceAcceleration, b: SourceAcceleration): boolean {
  if (a.degraded !== b.degraded || a.reason !== b.reason || a.steps.length !== b.steps.length)
    return false;
  return a.steps.every((step, i) => {
    const other = b.steps[i];
    return (
      other !== undefined &&
      step.step === other.step &&
      step.backend === other.backend &&
      step.hardware === other.hardware &&
      step.readbacks === other.readbacks &&
      step.uploads === other.uploads
    );
  });
}
