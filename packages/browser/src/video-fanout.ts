/*
 * Encoded video to each viewer, at the pace that viewer acknowledges (ADR 0088). Pure: no
 * timers or I/O, so the drop and keyframe rules are tested directly.
 *
 * Every delta needs the ones before it, so a viewer has a window of unacknowledged chunks and
 * acks are cumulative. The window is a full second of 60 fps video: it holds a phone link's
 * round trip with room for jitter, so on a link that keeps up nothing is ever dropped. The
 * encode's bit rate follows each viewer's link (`link-rate.ts`), which keeps the window from
 * filling; a delta that still doesn't fit is dropped, with every later delta until the next
 * keyframe, and a keyframe is asked for. Keyframes are never dropped: one that doesn't fit
 * waits in the viewer's queue (replacing an older one), and the deltas after it queue behind it,
 * up to the window's frames and bytes.
 *
 * Each change of encode starts a new generation: a new sequence space for acks (a new capture
 * may start its sequences over). The chunks still on the wire keep counting against the window
 * (they are the transport's debt, whatever encode the viewer moved to) until an ack releases
 * them. An ack names its generation (the current one by default) and releases every chunk sent
 * up to the newest of that generation it covers: on an in-order transport, the viewer having
 * that one proves everything sent before it arrived. A late ack of an old generation releases
 * only what was sent before it. `forget` drops a generation the transport confirms it dropped.
 *
 * No debt lives for ever: a chunk unacked for longer than its viewer's `lifetime` (the owner sets
 * it from the link, `LinkRate.lifetimeMs`; 2 s until then) is lost. Its bytes are released, the
 * owner hears of the loss (`lost`, which cuts the link's rate), deltas wait and a keyframe is
 * asked for. So no pause, switch or missing ack keeps a window full: video resumes within
 * the lifetime. Time is the injected `now`.
 *
 * The window is also bounded in time (ADR 0149): a viewer's owner may hold its bytes in flight
 * to what its link carries (`LinkRate.backlogBytes`), so a thin link never builds seconds of
 * backlog inside a window sized for a fast one.
 */

export interface VideoPiece {
  sequence: number;
  key: boolean;
  bytes: { readonly length: number };
}

export interface VideoSink<C extends VideoPiece> {
  /** False means transport backpressure; the chunk was not taken. */
  send(chunk: C): boolean;
}

export interface VideoWindow {
  /** Unacknowledged chunks a viewer may have. */
  frames: number;
  /** Unacknowledged bytes a viewer may have; a lone keyframe may exceed it. */
  bytes: number;
}

/** A chunk's lifetime in flight until its owner knows the link's round trip. */
export const defaultLifetimeMs = 2_000;

export const videoWindow: VideoWindow = { frames: 60, bytes: 8 * 1024 * 1024 };

export interface VideoFanoutOptions {
  /** An encode owes a keyframe (a viewer joined it, or dropped a delta, or asked). */
  keyframe(encode: string): void;
  /** A viewer started or stopped showing video. */
  playing(id: string, playing: boolean): void;
  /** A viewer's transport took a chunk (refused attempts are not reported). */
  sent?(id: string, sequence: number, bytes: number): void;
  /** A delta didn't fit a viewer's window and was dropped. */
  dropped?(id: string): void;
  /** Chunks went unacked past the viewer's lifetime: they are lost. */
  lost?(id: string): void;
  /** The clock chunks are stamped with when they go, and lost by. */
  now(): number;
  window?: VideoWindow;
}

interface Viewer<C extends VideoPiece> {
  id: string;
  sink: VideoSink<C>;
  encode: string | undefined;
  /** Bumped by every change of encode: its sequences are a space of their own. */
  generation: number;
  /** Chunks on the wire, in send order, whatever generation sent them, and when each went. */
  inflight: { sequence: number; bytes: number; generation: number; at: number }[];
  /** How long a chunk may go unacked before it is lost. */
  lifetime: number;
  inflightBytes: number;
  /** Starts with a keyframe whenever it isn't empty. */
  queue: C[];
  /** Bytes of everything in the queue. */
  queuedBytes: number;
  /** Deltas are dropped until the next keyframe. */
  needKey: boolean;
  /** A delta was dropped since the last keyframe this viewer got: it is falling behind. */
  dropping: boolean;
  playing: boolean;
  /** The bytes in flight its link carries in time; the window's bytes bound it too. */
  bound: number | undefined;
}

export class VideoFanout<C extends VideoPiece> {
  private viewers = new Map<string, Viewer<C>>();
  private options: VideoFanoutOptions;
  private window: VideoWindow;
  constructor(options: VideoFanoutOptions) {
    this.options = options;
    this.window = options.window ?? videoWindow;
  }
  /** A viewer that plays video; it shows nothing from here until its encode sends a keyframe. */
  add(id: string, sink: VideoSink<C>): void {
    this.remove(id);
    this.viewers.set(id, {
      id,
      sink,
      encode: undefined,
      generation: 0,
      inflight: [],
      lifetime: defaultLifetimeMs,
      inflightBytes: 0,
      queue: [],
      queuedBytes: 0,
      needKey: true,
      dropping: false,
      playing: false,
      bound: undefined,
    });
  }
  /**
   * Holds a viewer's bytes in flight to `bytes` (what its link carries in time), within the
   * window; undefined: the window alone. A lone keyframe may still exceed it.
   */
  bound(id: string, bytes: number | undefined): void {
    const viewer = this.viewers.get(id);
    if (viewer) viewer.bound = bytes;
  }
  /** How long a viewer's chunks may go unacked before they are lost (`LinkRate.lifetimeMs`). */
  lifetime(id: string, ms: number): void {
    const viewer = this.viewers.get(id);
    if (viewer) viewer.lifetime = ms;
  }
  remove(id: string): void {
    const viewer = this.viewers.get(id);
    if (!viewer) return;
    this.viewers.delete(id);
    if (viewer.playing) this.options.playing(id, false);
  }
  has(id: string): boolean {
    return this.viewers.has(id);
  }
  /** Moves a viewer to an encode (or none: it shows nothing). A new encode starts at a keyframe. */
  assign(id: string, encode: string | undefined): void {
    const viewer = this.viewers.get(id);
    if (!viewer || viewer.encode === encode) return;
    viewer.encode = encode;
    // Another sequence space; what is on the wire stays in flight, the transport's debt.
    viewer.generation++;
    setQueue(viewer, []);
    viewer.needKey = true;
    viewer.dropping = false;
    if (encode === undefined) this.stopPlaying(id, viewer);
    else this.options.keyframe(encode);
  }
  /** Every viewer's encode stopped (the capture moved to another tab, or failed). */
  stopAll(): void {
    for (const [id, viewer] of this.viewers) {
      if (viewer.encode !== undefined) viewer.generation++;
      viewer.encode = undefined;
      setQueue(viewer, []);
      viewer.needKey = true;
      viewer.dropping = false;
      this.stopPlaying(id, viewer);
    }
  }
  publish(encode: string, chunk: C): void {
    for (const viewer of this.viewers.values()) {
      // What a loss frees goes at once: a keyframe waiting behind lost chunks needn't wait on.
      if (this.expire(viewer) && viewer.encode !== undefined)
        this.flushViewer(viewer, viewer.encode);
      if (viewer.encode !== encode) continue;
      if (chunk.key) {
        // Everything queued is older than this picture.
        setQueue(viewer, [chunk]);
        viewer.needKey = false;
        viewer.dropping = false;
      } else if (viewer.needKey) {
        continue;
      } else if (viewer.queue.length || !this.fits(viewer, chunk)) {
        // Behind a waiting keyframe there is room for a window's worth of deltas; else drop.
        const head = viewer.queue[0];
        // The waiting keyframe may be bigger than the window on its own; deltas get the window.
        const allowance = this.bytes(viewer) + (head?.key ? head.bytes.length : 0);
        // A delta only the time bound holds back (the window would take it) waits its turn too.
        const waits = head !== undefined || this.fitsWindow(viewer, chunk);
        if (
          waits &&
          viewer.queue.length < this.window.frames &&
          viewer.queuedBytes + chunk.bytes.length <= allowance
        ) {
          viewer.queue.push(chunk);
          viewer.queuedBytes += chunk.bytes.length;
        } else this.drop(viewer, encode);
        continue;
      } else setQueue(viewer, [chunk]);
      this.flushViewer(viewer, encode);
    }
  }
  /** The generation a viewer's chunks are sent in now: an ack of them names it. */
  generation(id: string): number | undefined {
    return this.viewers.get(id)?.generation;
  }
  /**
   * The viewer showed every chunk of `generation` up to `sequence`: it and everything sent
   * before it are off the wire.
   */
  acknowledge(id: string, sequence: number, generation: number): void {
    const viewer = this.viewers.get(id);
    if (!viewer) return;
    let last = -1;
    for (let index = 0; index < viewer.inflight.length; index++) {
      const entry = viewer.inflight[index];
      if (entry?.generation === generation && entry.sequence <= sequence) last = index;
    }
    this.release(viewer, last + 1);
  }
  /**
   * The viewer showed every chunk up to `sequence`, whatever generation sent it: for an owner
   * whose sequences only increase across generations (a paused view's acks name nothing else).
   */
  acknowledgeThrough(id: string, sequence: number): void {
    const viewer = this.viewers.get(id);
    if (!viewer) return;
    let count = 0;
    while (count < viewer.inflight.length && (viewer.inflight[count]?.sequence ?? 0) <= sequence)
      count++;
    this.release(viewer, count);
  }
  /** Whether chunks of `generation` are still on the wire for a viewer. */
  owes(id: string, generation: number): boolean {
    return this.viewers.get(id)?.inflight.some((entry) => entry.generation === generation) ?? false;
  }
  /** The transport confirms it dropped `generation`'s chunks: they are off the wire. */
  forget(id: string, generation: number): void {
    const viewer = this.viewers.get(id);
    if (!viewer) return;
    viewer.inflight = viewer.inflight.filter((entry) => {
      if (entry.generation !== generation) return true;
      viewer.inflightBytes -= entry.bytes;
      return false;
    });
    this.expire(viewer);
    if (viewer.encode !== undefined) this.flushViewer(viewer, viewer.encode);
  }
  /** The first `count` chunks in flight are off the wire. */
  private release(viewer: Viewer<C>, count: number): void {
    for (const entry of viewer.inflight.splice(0, count)) viewer.inflightBytes -= entry.bytes;
    this.expire(viewer);
    if (viewer.encode !== undefined) this.flushViewer(viewer, viewer.encode);
  }
  /** Chunks unacked past the viewer's lifetime are lost: freed, reported, a keyframe owed. */
  private expire(viewer: Viewer<C>): boolean {
    const now = this.options.now();
    let lost = 0;
    while (
      lost < viewer.inflight.length &&
      now - (viewer.inflight[lost]?.at ?? now) > viewer.lifetime
    )
      lost++;
    if (!lost) return false;
    for (const entry of viewer.inflight.splice(0, lost)) viewer.inflightBytes -= entry.bytes;
    this.options.lost?.(viewer.id);
    viewer.dropping = true;
    // A keyframe already waiting starts the picture over; else deltas wait for one.
    if (viewer.queue[0]?.key) return true;
    setQueue(viewer, []);
    viewer.needKey = true;
    if (viewer.encode !== undefined) this.options.keyframe(viewer.encode);
    return true;
  }
  /** The viewer's decoder lost its place: deltas wait for the next keyframe. */
  keyframe(id: string): void {
    const viewer = this.viewers.get(id);
    if (!viewer || viewer.encode === undefined) return;
    viewer.needKey = true;
    setQueue(viewer, viewer.queue[0]?.key ? viewer.queue.slice(0, 1) : []);
    this.options.keyframe(viewer.encode);
  }
  /** Retries chunks the transport refused, and lets go of chunks lost past their lifetime. */
  flush(): void {
    for (const viewer of this.viewers.values()) {
      this.expire(viewer);
      if (viewer.encode !== undefined) this.flushViewer(viewer, viewer.encode);
    }
  }
  /** Whether a viewer is falling behind: chunks wait for it, or it lost deltas. */
  backlogged(id: string): boolean {
    const viewer = this.viewers.get(id);
    return viewer !== undefined && (viewer.queue.length > 0 || viewer.dropping);
  }
  playing(id: string): boolean {
    return this.viewers.get(id)?.playing ?? false;
  }
  clear(): void {
    for (const id of this.viewers.keys()) this.remove(id);
  }
  private bytes(viewer: Viewer<C>): number {
    return Math.min(this.window.bytes, viewer.bound ?? Infinity);
  }
  private fits(viewer: Viewer<C>, chunk: C): boolean {
    if (!viewer.inflight.length) return true;
    return (
      viewer.inflight.length < this.window.frames &&
      viewer.inflightBytes + chunk.bytes.length <= this.bytes(viewer)
    );
  }
  private fitsWindow(viewer: Viewer<C>, chunk: C): boolean {
    return (
      viewer.inflight.length < this.window.frames &&
      viewer.inflightBytes + chunk.bytes.length <= this.window.bytes
    );
  }
  private drop(viewer: Viewer<C>, encode: string): void {
    this.options.dropped?.(viewer.id);
    viewer.needKey = true;
    viewer.dropping = true;
    setQueue(viewer, viewer.queue[0]?.key ? viewer.queue.slice(0, 1) : []);
    this.options.keyframe(encode);
  }
  private flushViewer(viewer: Viewer<C>, encode: string): void {
    while (viewer.queue.length) {
      const chunk = viewer.queue[0];
      if (!chunk || !this.fits(viewer, chunk)) return;
      // In flight before it goes: a transport that acknowledges inside `send` finds it there,
      // and the flush that ack starts never sends it again.
      viewer.queue.shift();
      viewer.queuedBytes -= chunk.bytes.length;
      const entry = {
        sequence: chunk.sequence,
        bytes: chunk.bytes.length,
        generation: viewer.generation,
        at: this.options.now(),
      };
      viewer.inflight.push(entry);
      viewer.inflightBytes += entry.bytes;
      let sent = false;
      try {
        sent = viewer.sink.send(chunk);
      } catch {
        sent = false;
      }
      if (!sent) {
        // Refused: it waits at the head of the queue again, as if never sent.
        const index = viewer.inflight.indexOf(entry);
        if (index !== -1) {
          viewer.inflight.splice(index, 1);
          viewer.inflightBytes -= entry.bytes;
        }
        viewer.queue.unshift(chunk);
        viewer.queuedBytes += entry.bytes;
        return;
      }
      // Only a chunk the transport took counts as sent: retries of a refused one are not.
      this.options.sent?.(viewer.id, chunk.sequence, entry.bytes);
      if (chunk.key && !viewer.playing) {
        viewer.playing = true;
        this.options.playing(viewer.id, true);
      }
      if (viewer.encode !== encode) return;
    }
  }

  private stopPlaying(id: string, viewer: Viewer<C>): void {
    if (!viewer.playing) return;
    viewer.playing = false;
    this.options.playing(id, false);
  }
}

function setQueue<C extends VideoPiece>(viewer: Viewer<C>, queue: C[]): void {
  viewer.queue = queue;
  viewer.queuedBytes = queue.reduce((total, chunk) => total + chunk.bytes.length, 0);
}
