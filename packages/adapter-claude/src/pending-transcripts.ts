import type { Frame } from "@ace/engine-api";
import type { ClaudeState } from "./state.ts";
import { object, string } from "./native.ts";

/** A spawn id alone cannot identify a native child permission. Wait for the binding. */
export class PendingTranscripts {
  #frames = new Map<string, { frames: Frame[]; bytes: number }>();
  #bytes = 0;
  #count = 0;
  #overflow = false;
  defer(state: ClaudeState, frame: Frame): boolean {
    const data = object(frame.data);
    const spawn = string(data["parent_tool_use_id"]);
    if (
      frame.channel !== "sdk" ||
      !spawn ||
      state.children.has(spawn) ||
      !["assistant", "user", "stream_event"].includes(string(data["type"]))
    )
      return false;
    state.notice(frame.data, `unbound:${frame.seq}`);
    if (this.#overflow) return true;
    const bytes =
      frame.payload?.bytes ?? new TextEncoder().encode(JSON.stringify(frame.data)).length;
    const entry = this.#frames.get(spawn);
    if (
      this.#bytes + bytes > 4 * 1024 * 1024 ||
      this.#count >= 256 ||
      (!entry && this.#frames.size >= 128)
    ) {
      this.clear();
      this.#overflow = true;
      state.emit({
        type: "background.started",
        agent: state.root,
        task: state.key("unbound", "overflow"),
        kind: "other",
        title: "Claude child transcript recovery exceeded its limit",
        stoppable: false,
      });
      state.emit({
        type: "item.upsert",
        agent: state.root,
        item: state.key("notice", "transcript-overflow"),
        draft: {
          type: "notice",
          complete: true,
          level: "warning",
          text: "Claude deferred child transcript limit exceeded. Child work remains unresolved until the provider session exits.",
        },
      });
      return true;
    }
    this.#bytes += bytes;
    this.#count++;
    if (entry) {
      entry.frames.push(frame);
      entry.bytes += bytes;
    } else {
      this.#frames.set(spawn, { frames: [frame], bytes });
      // Conservative live work prevents a false done state before registration.
      state.emit({
        type: "background.started",
        agent: state.root,
        task: state.key("unbound", spawn),
        kind: "subagent",
        title: "Claude child awaiting task registration",
        stoppable: false,
      });
    }
    return true;
  }
  take(state: ClaudeState, spawn: string): Frame[] {
    const entry = this.#frames.get(spawn);
    if (!entry) return [];
    this.#frames.delete(spawn);
    this.#bytes -= entry.bytes;
    this.#count -= entry.frames.length;
    state.emit({
      type: "background.ended",
      task: state.key("unbound", spawn),
      status: "completed",
    });
    return entry.frames;
  }
  clear(): void {
    this.#frames.clear();
    this.#bytes = 0;
    this.#count = 0;
    this.#overflow = false;
  }
}
