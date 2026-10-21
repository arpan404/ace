import type { Key } from "@ace/core";
import type { Frame } from "@ace/engine-api";
import type { ClaudeState } from "./state.ts";
import { list, object, string, type Data } from "./native.ts";

/**
 * How long an unbound child may stay silent after the root's turn ended before its placeholder
 * stops holding the thread. Fresh frames for it open the placeholder again.
 */
export const unboundGraceMs = 10_000;

interface Deferred {
  frames: Frame[];
  bytes: number;
  /** Claude's `agent_id` on the child's frames: the task id that later registers it. */
  agent: string;
  /** Placeholder task while the child's work is live; undefined once it ended. */
  task: Key | undefined;
  until: number | undefined;
}

/**
 * Child frames that name a spawn this process has not registered yet. A spawn id alone cannot
 * identify a native child (Claude can resume a child under another call), so its frames wait
 * for the binding, and a conservative placeholder task keeps the thread from reading done.
 * Every placeholder ends: when its child binds, when its spawning call completes, after the
 * root's turn ended and the child stayed silent, or when the provider process goes away.
 */
export class PendingTranscripts {
  #frames = new Map<string, Deferred>();
  #toolSpawns = new Map<string, string>();
  #spawnTools = new Map<string, Set<string>>();
  #bytes = 0;
  #count = 0;
  #overflow: { task: Key; until: number | undefined } | undefined;
  defer(state: ClaudeState, frame: Frame, now: number): boolean {
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
    const agent = string(data["agent_id"]);
    const entry = this.#frames.get(spawn);
    // Claude names the child's task on its frames. A child resumed in a later process keeps its
    // first spawn id while its task registers under the resuming call.
    const known = agent ? state.nativeAgents.get(agent) : undefined;
    if (known && !entry) {
      state.bindChild(spawn, known);
      return false;
    }
    state.notice(frame.data, `unbound:${frame.seq}`);
    if (this.#overflow) {
      if (this.#overflow.until !== undefined) this.#overflow.until = now + unboundGraceMs;
      return true;
    }
    const bytes =
      frame.payload?.bytes ?? new TextEncoder().encode(JSON.stringify(frame.data)).length;
    if (
      this.#bytes + bytes > 4 * 1024 * 1024 ||
      this.#count >= 256 ||
      (!entry && this.#frames.size >= 128)
    ) {
      this.#overflowed(state, now);
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
    const deferred = entry ?? { frames: [], bytes: 0, agent, task: undefined, until: undefined };
    if (!entry) this.#frames.set(spawn, deferred);
    deferred.frames.push(frame);
    deferred.bytes += bytes;
    if (!deferred.agent) deferred.agent = agent;
    if (known) state.bindChild(spawn, known);
    this.#open(state, deferred, spawn, now);
    return true;
  }
  /** Children registered by now take the deferred frames that name their task. */
  bindRegistered(state: ClaudeState): void {
    for (const [spawn, entry] of this.#frames) {
      if (state.children.has(spawn) || !entry.agent) continue;
      const agent = state.nativeAgents.get(entry.agent);
      if (agent) state.bindChild(spawn, agent);
    }
  }
  take(state: ClaudeState, spawn: string): Frame[] {
    const entry = this.#frames.get(spawn);
    if (!entry) return [];
    this.#drop(spawn, entry);
    this.#end(state, entry, "completed");
    return entry.frames;
  }
  /**
   * Facts about a frame that was not deferred: the spawning call's result, or the end of the
   * spawn's task, means nothing is left to wait for under that spawn.
   */
  observe(state: ClaudeState, data: Data): void {
    if (!this.#frames.size) return;
    if (data["type"] === "user")
      for (const value of list(object(data["message"])["content"])) {
        const block = object(value);
        if (block["type"] !== "tool_result") continue;
        const entry = this.#frames.get(string(block["tool_use_id"]));
        if (entry) this.#end(state, entry, "stopped");
      }
    if (data["type"] === "system" && data["subtype"] === "task_notification") {
      const spawn = string(data["tool_use_id"]);
      const entry = this.#frames.get(spawn);
      if (!entry) return;
      // The child finished without ever binding; its frames have no owner left to replay into.
      this.#drop(spawn, entry);
      this.#end(state, entry, "stopped");
    }
  }
  /** The root's turn ended: unbound children have a grace period of silence left. */
  turnEnded(now: number): void {
    for (const entry of this.#frames.values()) if (entry.task) entry.until = now + unboundGraceMs;
    if (this.#overflow) this.#overflow.until = now + unboundGraceMs;
  }
  nextDeadline(): number | undefined {
    let next = this.#overflow?.until;
    for (const entry of this.#frames.values())
      if (entry.task && entry.until !== undefined && (next === undefined || entry.until < next))
        next = entry.until;
    return next;
  }
  expire(state: ClaudeState, now: number): void {
    for (const entry of this.#frames.values())
      if (entry.task && entry.until !== undefined && entry.until <= now)
        this.#end(state, entry, "stopped");
    if (this.#overflow?.until !== undefined && this.#overflow.until <= now) {
      // Dropped frames have nothing left to resolve; later unbound frames start a fresh budget.
      state.emit({ type: "background.ended", task: this.#overflow.task, status: "stopped" });
      this.#overflow = undefined;
    }
  }
  /** The provider process is gone or replaced: no placeholder of it can still be live. */
  close(state: ClaudeState): void {
    for (const entry of this.#frames.values()) this.#end(state, entry, "stopped");
    if (this.#overflow)
      state.emit({ type: "background.ended", task: this.#overflow.task, status: "stopped" });
    this.#frames.clear();
    this.#toolSpawns.clear();
    this.#spawnTools.clear();
    this.#bytes = 0;
    this.#count = 0;
    this.#overflow = undefined;
  }
  #open(state: ClaudeState, entry: Deferred, spawn: string, now: number): void {
    if (entry.task) {
      if (entry.until !== undefined) entry.until = now + unboundGraceMs;
      return;
    }
    entry.task = state.key("unbound", spawn);
    entry.until = state.active.has(state.root) ? undefined : now + unboundGraceMs;
    // Conservative live work prevents a false done state before registration. It stands for
    // the subagent itself, so every surface counts it as one.
    state.emit({
      type: "background.started",
      agent: state.root,
      task: entry.task,
      kind: "subagent",
      title: "Subagent",
      stoppable: false,
    });
  }
  #end(state: ClaudeState, entry: Deferred, status: "completed" | "stopped"): void {
    if (!entry.task) return;
    state.emit({ type: "background.ended", task: entry.task, status });
    entry.task = undefined;
    entry.until = undefined;
  }
  #drop(spawn: string, entry: Deferred): void {
    this.#frames.delete(spawn);
    for (const tool of this.#spawnTools.get(spawn) ?? []) this.#toolSpawns.delete(tool);
    this.#spawnTools.delete(spawn);
    this.#bytes -= entry.bytes;
    this.#count -= entry.frames.length;
  }
  #overflowed(state: ClaudeState, now: number): void {
    // Every deferred frame is dropped: their placeholders give way to one for the whole flood.
    for (const entry of this.#frames.values()) this.#end(state, entry, "stopped");
    this.#frames.clear();
    this.#toolSpawns.clear();
    this.#spawnTools.clear();
    this.#bytes = 0;
    this.#count = 0;
    this.#overflow = {
      task: state.key("unbound", "overflow"),
      until: state.active.has(state.root) ? undefined : now + unboundGraceMs,
    };
    // Bookkeeping: it holds the thread open, but no surface shows it. Its detail goes to the
    // daemon's log.
    state.emit({
      type: "background.started",
      agent: state.root,
      task: this.#overflow.task,
      kind: "other",
      title: "Unregistered subagent transcripts",
      internal: true,
      stoppable: false,
    });
    state.warn("deferred-transcripts-overflow", {
      detail:
        "Deferred subagent transcripts exceeded their limit and were dropped. Unregistered subagent work holds the thread until the main turn ends and the subagent goes quiet, or the provider session exits.",
    });
  }
}
