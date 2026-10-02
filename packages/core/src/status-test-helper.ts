import type { EventPayload } from "@ace/protocol";
import { deriveAgentStatus } from "./index.ts";
import { harness } from "./test-helper.ts";

export function activeRoot(
  config: NonNullable<Parameters<typeof harness>[1]> = { silenceMs: 100 },
) {
  const h = harness("codex", config);
  h.see();
  h.start();
  return h;
}

export function endedRoot(config: NonNullable<Parameters<typeof harness>[1]> = { silenceMs: 100 }) {
  const h = activeRoot(config);
  h.end();
  return h;
}

export function spawned(h: ReturnType<typeof harness>, background = false) {
  h.see("child", "root", background);
  h.start("child");
  return h.send({
    type: "item.upsert",
    agent: "root",
    item: "spawn",
    draft: {
      type: "tool_call",
      call: {
        kind: "agent.spawn",
        title: "Child",
        status: "running",
        detail: { kind: "agent.spawn", childAgent: "child" },
      },
    },
  });
}

export function createdItemId(events: EventPayload[]) {
  const event = events.find((payload) => payload.type === "item.created");
  if (event?.type !== "item.created") throw new Error("Expected item.created");
  return event.item.id;
}

export function status(h: ReturnType<typeof harness>, now: number, key = "root") {
  return deriveAgentStatus(h.state, key, now);
}
