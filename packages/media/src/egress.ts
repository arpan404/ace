import { decodeEgress, type MediaFrame } from "./frame.ts";
import type { SourceKind, SourceRoute } from "./routes.ts";

/**
 * The daemon's end of the egress lane (docs/media/plan.md, "Egress routing in the daemon"). Each
 * egress frame carries the handle the daemon gave its source in `source.open`; frames are
 * dispatched by that handle, never by encode id (encode ids are the producer's own, and two
 * sources may share them), to exactly the consumers the source's route keeps in the daemon.
 * The route is read live for every frame (`RouteWatch.routes()[kind]`), so the router never
 * holds a copy that can drift from the daemon's current table.
 */

/** One unit off the egress lane, as a legacy consumer receives it. */
export type EgressUnit = {
  source: string;
  frame: MediaFrame;
  /** ace-media's sequence for this source. */
  sequence: number;
  /** Units were dropped since the previous one (a full egress, or egress just turned on). */
  gap: boolean;
};

/** The daemon's legacy consumers of one source: `LiveVideo.publish` and the picture hubs, the
 * legacy recorder, and the legacy still maker. */
export type LegacyConsumers = {
  deliver: (unit: EgressUnit) => void;
  record: (unit: EgressUnit) => void;
  still: (unit: EgressUnit) => void;
};

export type EgressDrops = {
  /** Frames that did not decode. */
  invalid: number;
  /** A handle the daemon never gave out. */
  unknown: number;
  /** The handle of a source already closed. */
  closed: number;
  /** Units ace-media dropped, from gaps in its sequences. */
  gaps: number;
  /** Frames for a source whose route has no egress (in flight while its route changed). */
  unrouted: number;
};

type Open = {
  source: string;
  kind: SourceKind;
  consumers: LegacyConsumers;
  next: number | undefined;
};

const maxHandle = 0xffffffff;

export class EgressRouter {
  readonly #route: (kind: SourceKind) => SourceRoute;
  readonly #open = new Map<number, Open>();
  #nextHandle = 1;
  readonly #drops: EgressDrops = {
    invalid: 0,
    unknown: 0,
    closed: 0,
    gaps: 0,
    unrouted: 0,
  };

  /** `route` is the current route of a source kind, as the daemon's `RouteWatch` has it. */
  constructor(route: (kind: SourceKind) => SourceRoute) {
    this.#route = route;
  }

  /**
   * Gives a source its handle for `source.open`. Handles are never reused while the daemon
   * lives, so never while one ace-media process does, and a frame for a closed source can't
   * reach its successor.
   */
  open(source: string, kind: SourceKind, consumers: LegacyConsumers): number {
    if (this.#nextHandle > maxHandle) throw new Error("Egress handles exhausted");
    const handle = this.#nextHandle++;
    this.#open.set(handle, { source, kind, consumers, next: undefined });
    return handle;
  }

  close(handle: number): void {
    this.#open.delete(handle);
  }

  drops(): EgressDrops {
    return { ...this.#drops };
  }

  /** One whole egress frame from the lane (`egressFrameReader`). */
  push(bytes: Uint8Array): void {
    let egress: ReturnType<typeof decodeEgress>;
    try {
      egress = decodeEgress(bytes);
    } catch {
      this.#drops.invalid++;
      return;
    }
    const open = this.#open.get(egress.handle);
    if (!open) {
      if (egress.handle > 0 && egress.handle < this.#nextHandle) this.#drops.closed++;
      else this.#drops.unknown++;
      return;
    }
    // A route that moved the producer back to the daemon has no egress: frames ace-media sent
    // before it heard `source.egress` off would reach the consumers twice.
    const route = this.#route(open.kind);
    if (!route.egress) {
      this.#drops.unrouted++;
      return;
    }
    const lost = open.next === undefined ? 0 : (egress.sequence - open.next) >>> 0;
    this.#drops.gaps += lost;
    open.next = (egress.sequence + 1) >>> 0;
    const unit: EgressUnit = {
      source: open.source,
      frame: egress.frame,
      sequence: egress.sequence,
      gap: lost > 0,
    };
    const { consumers } = open;
    if (route.deliverer === "legacy") consumers.deliver(unit);
    if (route.recorder === "legacy") consumers.record(unit);
    if (route.stills === "legacy") consumers.still(unit);
  }
}
