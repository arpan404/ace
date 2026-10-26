import type { SkillOperation } from "@ace/protocol";
import type { SocketContext, SocketService } from "./socket.ts";

const reads = new Set<SkillOperation["op"]>(["list", "read", "usage"]);
/** `skills.request` (ADR 0103). Subscribed lists push `skills.changed` until unsubscribed. */
export function createSkillLibrarySession(context: SocketContext): SocketService {
  const stops = new Map<string, () => void>();
  const unsubscribe = (requestId: string) => {
    stops.get(requestId)?.();
    stops.delete(requestId);
  };
  function watch(requestId: string, workspaceId: string | undefined, initial: string) {
    const library = context.options.skillLibrary;
    if (!library || stops.size >= 8) return;
    let previous = initial;
    let running = false;
    let dirty = false;
    let stopped = false;
    const push = async () => {
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      try {
        do {
          dirty = false;
          if (stopped || !context.connected() || !context.authorize("read")) return;
          const result = await library.request({ op: "list", workspaceId });
          if (
            stopped ||
            result.kind !== "list" ||
            !context.connected() ||
            !context.authorize("read")
          )
            return;
          const encoded = JSON.stringify(result.entries);
          if (encoded === previous) continue;
          previous = encoded;
          context.send({
            type: "skills.changed",
            requestId,
            entries: result.entries,
            stale: false,
          });
        } while (dirty);
      } finally {
        running = false;
      }
    };
    try {
      const stop = library.subscribe(workspaceId, () => void push().catch(() => {}));
      stops.set(requestId, () => {
        stopped = true;
        stop();
      });
    } catch {
      /* Subscription limits leave the reply valid without pushes. */
    }
  }
  return {
    close() {
      for (const stop of stops.values()) stop();
      stops.clear();
    },
    async handle(message) {
      if (message.type === "skills.unsubscribe") {
        unsubscribe(message.requestId);
        return true;
      }
      if (message.type !== "skills.request") return false;
      const operation = message.operation;
      const scope = reads.has(operation.op) ? "read" : "operate";
      const allowed = () => context.connected() && context.authorize(scope);
      if (!allowed()) {
        context.send({
          type: "skills.result",
          requestId: message.requestId,
          result: {
            kind: "error",
            code: "forbidden",
            message: "This device isn't allowed to change skills.",
          },
        });
        return true;
      }
      const library = context.options.skillLibrary;
      const result = library
        ? await library.request(operation)
        : {
            kind: "error" as const,
            code: "unavailable" as const,
            message: "Skills aren't ready yet. Reconnect and try again.",
          };
      if (!allowed()) return true;
      context.send({ type: "skills.result", requestId: message.requestId, result });
      if (operation.op === "list" && operation.subscribe && result.kind === "list") {
        unsubscribe(message.requestId);
        // The reply is the first snapshot; pushes only carry later changes.
        watch(message.requestId, operation.workspaceId, JSON.stringify(result.entries));
      }
      return true;
    },
  };
}
