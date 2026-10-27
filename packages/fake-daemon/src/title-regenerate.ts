import type { EventPayload, ThreadView } from "@ace/protocol";
import { provisionalTitle } from "@ace/ui-core";

/**
 * `thread.title.regenerate` as the fake answers it: the opening request's first words, the title
 * the daemon sets before its utility model's arrives (the fake has no utility model). Undefined
 * when the thread holds no request of the person's.
 */
export function regeneratedTitle(view: ThreadView): EventPayload | undefined {
  const opening = Object.values(view.items)
    .filter((item) => item.type === "message" && item.role === "user" && !item.synthetic)
    .toSorted((a, b) => a.createdAt - b.createdAt)[0];
  if (opening?.type !== "message") return undefined;
  return {
    type: "thread.updated",
    title: provisionalTitle(opening.parts),
    titleSource: "provisional",
  };
}
