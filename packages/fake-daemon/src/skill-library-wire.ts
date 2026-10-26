import type { ClientMessage, ServerMessage } from "@ace/protocol";
import type { FakeSkillLibrary } from "./skill-library.ts";

/** One connection's skill requests and `list` subscriptions, which push `skills.changed`. */
export function skillSession(library: FakeSkillLibrary, send: (message: ServerMessage) => void) {
  const subscriptions = new Map<string, string | undefined>();
  const push = () => {
    for (const [requestId, workspaceId] of subscriptions)
      send({ type: "skills.changed", requestId, entries: library.list(workspaceId), stale: false });
  };
  const stop = library.subscribe(push);
  return {
    handle(message: ClientMessage): boolean {
      if (message.type === "skills.unsubscribe") {
        subscriptions.delete(message.requestId);
        return true;
      }
      if (message.type !== "skills.request") return false;
      const operation = message.operation;
      const result = library.request(operation);
      send({ type: "skills.result", requestId: message.requestId, result });
      if (operation.op === "list" && operation.subscribe && subscriptions.size < 16)
        subscriptions.set(message.requestId, operation.workspaceId);
      return true;
    },
    close() {
      subscriptions.clear();
      stop();
    },
  };
}
