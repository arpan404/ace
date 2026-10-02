import type { Frame } from "@ace/engine-api";
import type { ClaudeState } from "./state.ts";
import { object, string } from "./native.ts";

/** A spawn id alone cannot identify a native child permission. Wait for the binding. */
export class PendingTranscripts {
  #frames = new Map<string, Frame[]>();
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
    const frames = this.#frames.get(spawn);
    if (frames) frames.push(frame);
    else {
      this.#frames.set(spawn, [frame]);
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
    state.notice(frame.data, `unbound:${frame.seq}`);
    return true;
  }
  take(state: ClaudeState, spawn: string): Frame[] {
    const frames = this.#frames.get(spawn);
    if (!frames) return [];
    this.#frames.delete(spawn);
    state.emit({
      type: "background.ended",
      task: state.key("unbound", spawn),
      status: "completed",
    });
    return frames;
  }
  clear(): void {
    this.#frames.clear();
  }
}
