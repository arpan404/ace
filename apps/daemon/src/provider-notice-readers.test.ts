import { expect, test } from "vitest";
import { Item } from "@ace/protocol";
import { threadOutcome } from "./agent-control/results.ts";
import {
  agentMessage,
  catchUp,
  end,
  start,
  storeFixture,
  turns,
  userMessage,
} from "./long-thread-test-support.ts";

/* An OpenCode `<shell>` notice as rows stored before the adapter classified it: assistant role. */
const storedShellNotice = (id: string, runId: string) =>
  Item.parse({
    ...agentMessage(
      id,
      '<shell id="sh_1" state="completed" command="bun run check">\n 2 files changed\n</shell>',
      runId,
    ),
    synthetic: true,
    raw: [
      {
        type: "projected.message",
        data: { type: "synthetic", metadata: { source: "shell" } },
      },
    ],
  });

function threadWithLateNotice() {
  const f = storeFixture();
  f.store.appendEvents(f.thread.id, [{ type: "item.created", item: userMessage("ask", "Fix") }]);
  start(f.store, f.thread, "run", 20);
  f.store.appendEvents(
    f.thread.id,
    [
      { type: "item.created", item: agentMessage("answer", "Cart totals now round", "run") },
      { type: "item.created", item: storedShellNotice("notice", "run") },
    ],
    25,
  );
  end(f.store, f.thread, "run", 30);
  return f;
}

test("a delegated child's result is its answer, not a provider notice stored after it", () => {
  const f = threadWithLateNotice();
  const thread = f.store.getThread(f.thread.id);
  if (!thread) throw new Error("missing thread");
  expect(threadOutcome(f.store, thread).result).toBe("Cart totals now round");
});

test("a turn's latest agent message skips a provider notice stored as assistant prose", () => {
  const f = threadWithLateNotice();
  expect(turns(f.store, f.thread).turns[0]?.latestAgentMessagePreview).toBe(
    "Cart totals now round",
  );
  expect(catchUp(f.store, f.thread, { sinceSeq: 0 }).latestAgentMessagePreview).toBe(
    "Cart totals now round",
  );
});

test("an assistant message that only looks like a notice is still the agent's answer", () => {
  const f = storeFixture();
  start(f.store, f.thread, "run", 20);
  const text = '<shell id="x">quoted</shell>';
  f.store.appendEvents(
    f.thread.id,
    [{ type: "item.created", item: agentMessage("answer", text, "run") }],
    25,
  );
  end(f.store, f.thread, "run", 30);
  const thread = f.store.getThread(f.thread.id);
  if (!thread) throw new Error("missing thread");
  expect(threadOutcome(f.store, thread).result).toBe(text);
  expect(turns(f.store, f.thread).turns[0]?.latestAgentMessagePreview).toBe(text);
});
