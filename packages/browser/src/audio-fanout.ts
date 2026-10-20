import type { CaptureViewer } from "./capture-policy.ts";

/*
 * The page's sound to the viewers that unmuted it (ADR 0088, Audio). Pure: no timers or I/O.
 *
 * Every viewer starts muted. Only a viewer that plays video and turned its speaker on listens,
 * and the tab's audio is encoded only while at least one viewer listens, so a muted viewer
 * costs nothing and receives no audio bytes. Audio is never acknowledged: a chunk the transport
 * refuses is dropped, since sound that arrives late is worse than a short gap.
 */

export interface AudioSink<C> {
  /** False means transport backpressure; the chunk was not taken. */
  send(chunk: C): boolean;
}

/** Whether this viewer hears the page: it plays video, unmuted, and no native view covers it. */
export function listens(capture: CaptureViewer): boolean {
  return (
    capture.video !== undefined &&
    capture.viewport.audio === true &&
    capture.viewport.nativeShown !== true
  );
}

export class AudioFanout<C> {
  private listeners = new Map<string, AudioSink<C>>();
  /** A viewer's choice: it hears the page through `sink`, or (undefined) it is muted. */
  set(id: string, sink: AudioSink<C> | undefined): void {
    if (sink) this.listeners.set(id, sink);
    else this.listeners.delete(id);
  }
  remove(id: string): void {
    this.listeners.delete(id);
  }
  /** Someone listens: the tab's audio is captured and encoded only while this holds. */
  get wanted(): boolean {
    return this.listeners.size > 0;
  }
  publish(chunk: C): void {
    for (const sink of this.listeners.values()) {
      try {
        sink.send(chunk);
      } catch {
        // A closed transport: the viewer leaves with its connection.
      }
    }
  }
  clear(): void {
    this.listeners.clear();
  }
}
