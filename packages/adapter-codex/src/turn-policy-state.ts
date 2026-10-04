import type { PermissionMode } from "@ace/protocol";
import { list, obj, str } from "./native.ts";

/** Native turn/action authority is independent of the latest composer acknowledgement. */
export function turnPolicyState(initial: PermissionMode) {
  const turns = new Map<string, PermissionMode>();
  const threads = new Map<string, PermissionMode>();
  const items = new Map<string, PermissionMode>();
  const submitting = new Map<string, PermissionMode>();
  const requests = new Map<unknown, { thread: string; mode: PermissionMode }>();
  const identity = (thread: string, native: string) => JSON.stringify([thread, native]);
  const retain = (map: Map<string, PermissionMode>, key: string, mode: PermissionMode) => {
    if (map.size >= 8192 && !map.has(key)) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, mode);
  };
  function policy(thread: string, turn: string, item = ""): PermissionMode {
    return (
      items.get(identity(thread, item)) ??
      turns.get(identity(thread, turn)) ??
      submitting.get(thread) ??
      "ask"
    );
  }
  return {
    submit(thread: string, mode: PermissionMode) {
      submitting.set(thread, mode);
    },
    root(thread: string) {
      if (!threads.has(thread)) retain(threads, thread, initial);
    },
    sent(id: unknown, thread: string): PermissionMode {
      const mode = submitting.get(thread) ?? "ask";
      requests.set(id, { thread, mode });
      return mode;
    },
    reply(id: unknown, turn: string): void {
      const entry = requests.get(id);
      requests.delete(id);
      if (!entry) return;
      submitting.delete(entry.thread);
      if (turn) {
        retain(turns, identity(entry.thread, turn), entry.mode);
        retain(threads, entry.thread, entry.mode);
      }
    },
    observe(method: string, params: unknown): void {
      const p = obj(params),
        thread = str(p["threadId"]),
        turn = str(p["turnId"], str(obj(p["turn"])["id"]));
      const mode =
        method === "turn/started"
          ? (turns.get(identity(thread, turn)) ??
            submitting.get(thread) ??
            threads.get(thread) ??
            "ask")
          : policy(thread, turn);
      if (method === "turn/started") retain(turns, identity(thread, turn), mode);
      if (method === "item/started" || method === "item/completed") {
        const item = obj(p["item"]);
        const id = str(item["id"]);
        // Completion can arrive after a new root turn; never overwrite an action's original mode.
        if (id && !items.has(identity(thread, id))) retain(items, identity(thread, id), mode);
        const children =
          item["type"] === "subAgentActivity" && item["kind"] === "started"
            ? [item["agentThreadId"]]
            : item["type"] === "collabAgentToolCall" && item["tool"] === "spawnAgent"
              ? list(item["receiverThreadIds"])
              : [];
        for (const child of children)
          if (typeof child === "string" && child && !threads.has(child))
            retain(threads, child, mode);
      }
    },
    policy,
  };
}
