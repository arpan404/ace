import type { EventPayload, ThreadView } from "@ace/protocol";
import { provisionalTitle } from "@ace/ui-core";

/**
 * `thread.title.regenerate` as the fake answers it: the opening request's first words, the title
 * the daemon sets before its utility model's arrives (the fake has no utility model). The request
 * is picked as the daemon picks it: the person's own or queued first message with prose to name
 * it by. Undefined when the thread holds none.
 */
export function regeneratedTitle(view: ThreadView): EventPayload | undefined {
  for (const item of Object.values(view.items).toSorted((a, b) => a.createdAt - b.createdAt)) {
    if (item.type !== "message" || item.role !== "user" || item.synthetic) continue;
    const origin = item.origin?.kind ?? "person";
    if (origin !== "person" && origin !== "queue") continue;
    const title = provisionalTitle(item.parts);
    if (title !== "New thread")
      return { type: "thread.updated", title, titleSource: "provisional" };
  }
  return undefined;
}
