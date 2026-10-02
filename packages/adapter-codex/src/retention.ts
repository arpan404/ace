import type { Frame } from "@ace/engine-api";
import type { Agent } from "./translator-state.ts";
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
/** Raw facts are emitted before buffering. Loss of replay data requires a full thread read. */
export function unknownBuffers() {
  const retained = new Map<Frame, { agent: Agent; bytes: number }>();
  let bytes = 0;
  function discard(frame: Frame, lost: boolean) {
    const entry = retained.get(frame);
    if (!entry) return;
    retained.delete(frame);
    bytes -= entry.bytes;
    const index = entry.agent.buffer.indexOf(frame);
    if (index >= 0) entry.agent.buffer.splice(index, 1);
    if (lost) entry.agent.bufferLost = true;
  }
  return {
    push(agent: Agent, frame: Frame) {
      const size = JSON.stringify(frame).length * 2;
      if (size > 64 * 1024) {
        agent.bufferLost = true;
        return;
      }
      agent.buffer.push(frame);
      retained.set(frame, { agent, bytes: size });
      bytes += size;
      if (agent.buffer.length > 64) {
        const first = agent.buffer[0];
        if (first) discard(first, true);
      }
      while (bytes > 512 * 1024 || retained.size > 256) {
        const first = retained.keys().next().value;
        if (!first) break;
        discard(first, true);
      }
    },
    take(agent: Agent): Frame[] {
      const frames = [...agent.buffer];
      for (const frame of frames) discard(frame, false);
      return frames;
    },
  };
}
