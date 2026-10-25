import { join } from "node:path";
import { Store } from "@ace/daemon";
import { Item, Thread, ThreadId, type EventPayload } from "@ace/protocol";

const answer = "The change is in place and the tests pass. ".repeat(40);

/**
 * Finished threads, each with a question and a 1.7 KB answer, written straight into a stopped
 * daemon's store. History-proportional costs (startup, sidebar, fan-out) then show up in
 * every measurement that follows.
 */
export function seedThreads(
  aceHome: string,
  project: string,
  count: number,
  at = 1_700_000_000_000,
) {
  if (count <= 0) return;
  const store = new Store(join(aceHome, "events.sqlite"));
  try {
    const workspaceId = store.createWorkspace(project, "Seeded history", at);
    store.atomic(() => {
      for (let index = 0; index < count; index++) {
        const time = at + index * 1000;
        const id = ThreadId.parse(`seeded-${index}`);
        const thread = Thread.parse({
          id,
          workspaceId,
          provider: "claude",
          title: `Seeded task ${index}`,
          status: { state: "done" },
          createdAt: time,
          updatedAt: time + 500,
          activityAt: time + 500,
          hasSentMessage: true,
        });
        const message = (role: "user" | "assistant", text: string, offset: number) =>
          Item.parse({
            type: "message",
            id: `${id}-${role}`,
            agentId: "root",
            createdAt: time + offset,
            complete: true,
            role,
            parts: [{ type: "text", text }],
          });
        const events: EventPayload[] = [
          { type: "thread.created", thread },
          { type: "item.created", item: message("user", `Fix issue ${index}`, 1) },
          { type: "item.created", item: message("assistant", answer, 400) },
        ];
        store.appendEvents(id, events, time);
      }
    });
  } finally {
    store.close();
  }
}
