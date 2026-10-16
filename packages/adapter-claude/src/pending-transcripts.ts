import type { Frame } from "@ace/engine-api";
import type { ClaudeState } from "./state.ts";
import { list, object, string } from "./native.ts";

/** A spawn id alone cannot identify a native child permission. Wait for the binding. */
export class PendingTranscripts {
  #frames = new Map<string, { frames: Frame[]; bytes: number }>();
  #toolSpawns = new Map<string, string>();
  #spawnTools = new Map<string, Set<string>>();
  #bytes = 0;
  #count = 0;
  #overflow = false;
  defer(state: ClaudeState, frame: Frame): boolean {
    const data = object(frame.data);
    const blocks = list(object(data["message"])["content"]).map(object);
    const resultSpawn =
      data["type"] === "user"
        ? blocks
            .map((block) =>
              block["type"] === "tool_result"
                ? this.#toolSpawns.get(string(block["tool_use_id"]))
                : undefined,
            )
            .find(Boolean)
        : undefined;
    const spawn = string(data["parent_tool_use_id"]) || resultSpawn || "";
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
    for (const block of blocks) {
      if (block["type"] !== "tool_use") continue;
      const id = string(block["id"]);
      if (!id) continue;
      this.#toolSpawns.set(id, spawn);
      let tools = this.#spawnTools.get(spawn);
      if (!tools) this.#spawnTools.set(spawn, (tools = new Set()));
      tools.add(id);
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
    for (const tool of this.#spawnTools.get(spawn) ?? []) this.#toolSpawns.delete(tool);
    this.#spawnTools.delete(spawn);
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
    this.#toolSpawns.clear();
    this.#spawnTools.clear();
    this.#bytes = 0;
    this.#count = 0;
    this.#overflow = false;
  }
}
