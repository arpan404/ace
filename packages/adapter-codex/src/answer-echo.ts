import { createHash } from "node:crypto";
import { InteractionId, type MessageOrigin } from "@ace/protocol";
import { obj, str } from "./native.ts";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Match only the next exact-text echo in the answered thread, retaining provenance on updates. */
export function answerEchoes() {
  const pending: { thread: string; key: string; text: string; origin: MessageOrigin }[] = [];
  const matched = new Map<string, MessageOrigin>();
  return {
    note(data: unknown): void {
      const note = obj(data);
      const thread = str(note["threadId"]),
        key = str(note["interaction"]);
      if (note["event"] === "interaction-answer-failed") {
        const index = pending.findIndex((entry) => entry.thread === thread && entry.key === key);
        if (index >= 0) pending.splice(index, 1);
      } else if (
        note["event"] === "interaction-answer" &&
        thread &&
        thread.length <= 1024 &&
        key.length <= 1024 &&
        typeof note["text"] === "string"
      ) {
        const id = InteractionId.safeParse(note["interactionId"]);
        if (pending.length >= 256) pending.shift();
        pending.push({
          thread,
          key,
          text: digest(note["text"]),
          origin: { kind: "interaction_answer", ...(id.success ? { interactionId: id.data } : {}) },
        });
      }
    },
    match(thread: string, item: string, text: string): MessageOrigin | undefined {
      if (thread.length > 1024 || item.length > 1024) return undefined;
      const identity = JSON.stringify([thread, item]);
      const previous = matched.get(identity);
      if (previous) return previous;
      const hash = digest(text);
      const index = pending.findIndex((entry) => entry.thread === thread && entry.text === hash);
      if (index < 0) return undefined;
      const [entry] = pending.splice(index, 1);
      if (!entry) return undefined;
      if (matched.size >= 1024) {
        const oldest = matched.keys().next().value;
        if (oldest !== undefined) matched.delete(oldest);
      }
      matched.set(identity, entry.origin);
      return entry.origin;
    },
  };
}
