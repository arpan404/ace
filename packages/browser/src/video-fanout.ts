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

export const videoWindow: VideoWindow = { frames: 60, bytes: 8 * 1024 * 1024 };

export interface VideoFanoutOptions {
  /** An encode owes a keyframe (a viewer joined it, or dropped a delta, or asked). */
  keyframe(encode: string): void;
  /** A viewer started or stopped showing video. */
  playing(id: string, playing: boolean): void;
  /** A chunk went to a viewer's transport. */
  sent?(id: string, sequence: number, bytes: number): void;
  /** A delta didn't fit a viewer's window and was dropped. */
  dropped?(id: string): void;
  window?: VideoWindow;
}

interface Viewer<C extends VideoPiece> {
  id: string;
  sink: VideoSink<C>;
  encode: string | undefined;
  inflight: { sequence: number; bytes: number }[];
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
      inflight: [],
      inflightBytes: 0,
      queue: [],
      queuedBytes: 0,
      needKey: true,
      dropping: false,
      playing: false,
    });
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
    setQueue(viewer, []);
    viewer.needKey = true;
    viewer.dropping = false;
    if (encode === undefined) this.stopPlaying(id, viewer);
    else this.options.keyframe(encode);
  }
  /** Every viewer's encode stopped (the capture moved to another tab, or failed). */
  stopAll(): void {
    for (const [id, viewer] of this.viewers) {
      viewer.encode = undefined;
      setQueue(viewer, []);
      viewer.needKey = true;
      viewer.dropping = false;
      this.stopPlaying(id, viewer);
    }
  }
  publish(encode: string, chunk: C): void {
    for (const viewer of this.viewers.values()) {
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
        const allowance = this.window.bytes + (head?.key ? head.bytes.length : 0);
        if (
          head &&
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
  /** The viewer showed every chunk up to `sequence`. */
  acknowledge(id: string, sequence: number): void {
    const viewer = this.viewers.get(id);
    if (!viewer) return;
    let index = 0;
    while (index < viewer.inflight.length && (viewer.inflight[index]?.sequence ?? 0) <= sequence)
      viewer.inflightBytes -= viewer.inflight[index++]?.bytes ?? 0;
    viewer.inflight.splice(0, index);
    if (viewer.encode !== undefined) this.flushViewer(viewer, viewer.encode);
  }
  /** The viewer's decoder lost its place: deltas wait for the next keyframe. */
  keyframe(id: string): void {
    const viewer = this.viewers.get(id);
    if (!viewer || viewer.encode === undefined) return;
    viewer.needKey = true;
    setQueue(viewer, viewer.queue[0]?.key ? viewer.queue.slice(0, 1) : []);
    this.options.keyframe(viewer.encode);
  }
  /** Retries chunks the transport refused. */
  flush(): void {
    for (const viewer of this.viewers.values())
      if (viewer.encode !== undefined) this.flushViewer(viewer, viewer.encode);
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
  private fits(viewer: Viewer<C>, chunk: C): boolean {
    if (!viewer.inflight.length) return true;
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
      const entry = { sequence: chunk.sequence, bytes: chunk.bytes.length };
      viewer.inflight.push(entry);
      viewer.inflightBytes += entry.bytes;
      this.options.sent?.(viewer.id, chunk.sequence, entry.bytes);
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
        return;
      }
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
