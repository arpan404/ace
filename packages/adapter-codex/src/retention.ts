import type { Frame } from "@ace/engine-api";
/** Closed identifiers are replay hints, not an archive of provider history. */
export class RecentSet extends Set<string> {
  override add(value: string): this {
    super.delete(value);
    super.add(value);
    if (this.size > 1024) {
      const oldest = this.values().next().value;
      if (oldest !== undefined) super.delete(oldest);
    }
    return this;
  }
}
/** Raw facts precede buffering. Eviction keeps one guard until an authoritative scan. */
export function unknownBuffers() {
  const threads = new Map<string, { frames: Frame[]; lost: boolean }>();
  const retained = new Map<Frame, { id: string; bytes: number }>();
  let bytes = 0;
  let overflow = false;
  function discard(frame: Frame, lost: boolean) {
    const entry = retained.get(frame);
    if (!entry) return;
    retained.delete(frame);
    bytes -= entry.bytes;
    const thread = threads.get(entry.id);
    if (!thread) return;
    const index = thread.frames.indexOf(frame);
    if (index >= 0) thread.frames.splice(index, 1);
    if (lost) thread.lost = true;
  }
  return {
    get pending() {
      return threads.size;
    },
    get overflow() {
      return overflow;
    },
    clear() {
      threads.clear();
      retained.clear();
      bytes = 0;
      overflow = false;
    },
    push(id: string, frame: Frame) {
      let thread = threads.get(id);
      if (!thread) {
        if (threads.size >= 256) {
          const oldest = threads.keys().next().value;
          if (oldest !== undefined) {
            for (const retainedFrame of threads.get(oldest)?.frames.slice() ?? [])
              discard(retainedFrame, false);
            threads.delete(oldest);
            overflow = true;
          }
        }
        thread = { frames: [], lost: false };
        threads.set(id, thread);
      }
      const size = JSON.stringify(frame).length * 2;
      if (size > 64 * 1024) {
        thread.lost = true;
        return;
      }
      thread.frames.push(frame);
      retained.set(frame, { id, bytes: size });
      bytes += size;
      if (thread.frames.length > 64) {
        const first = thread.frames[0];
        if (first) discard(first, true);
      }
      while (bytes > 512 * 1024 || retained.size > 256) {
        const first = retained.keys().next().value;
        if (!first) break;
        discard(first, true);
      }
    },
    take(id: string): { frames: Frame[]; lost: boolean } {
      const thread = threads.get(id);
      // Whole-thread eviction has no per-id tombstones; conservatively require a read.
      if (!thread) return { frames: [], lost: overflow };
      const frames = [...thread.frames];
      for (const frame of frames) discard(frame, false);
      threads.delete(id);
      return { frames, lost: thread.lost };
    },
  };
}
