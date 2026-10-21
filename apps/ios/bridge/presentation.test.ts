// oxlint-disable-next-line import/no-unassigned-import -- Install the test host before the bridge reads it.
import "./test-host.ts";
import { expect, test } from "vitest";
import { Item, ThreadListEntry } from "@ace/protocol";
import { itemRow, threadRow } from "./presentation.ts";

let ids = 0;
function stored(text: string, extra: Record<string, unknown> = {}) {
  return Item.parse({
    id: `m-${++ids}`,
    agentId: "root",
    createdAt: ids,
    complete: true,
    type: "message",
    role: "user",
    parts: [{ type: "text", text }],
    ...extra,
  });
}

test("an old opencode shell notice reads as a quiet finished line, not an assistant bubble", () => {
  const row = itemRow(
    stored('<shell id="sh_1" state="completed" command="bun run check">ok</shell>', {
      role: "assistant",
      synthetic: true,
      raw: [
        { type: "projected.message", data: { type: "synthetic", metadata: { source: "shell" } } },
      ],
    }),
  );
  expect(row.role).toBe("");
  expect(row.type).toBe("notice");
  expect(row.text).toBe("Background task finished: bun run check");
  expect(row.text).not.toContain("<shell");
});

test("a Claude background notice on a user message reads the same quiet line", () => {
  const row = itemRow(
    stored(
      '<task-notification>\n<task-id>bd0rixyq4</task-id>\n<summary>Background command "bun run check" completed (exit code 0)</summary>\n</task-notification>',
      { synthetic: true },
    ),
  );
  expect(row.role).toBe("");
  expect(row.type).toBe("notice");
  expect(row.text).toBe("Background task finished: bun run check");
  expect(row.text).not.toContain("<task-notification");
});

test("an ordinary person message keeps its user bubble", () => {
  const row = itemRow(stored("Fix the export"));
  expect(row.role).toBe("user");
  expect(row.type).toBe("message");
  expect(row.text).toBe("Fix the export");
});

test("an ordinary assistant reply keeps its bubble", () => {
  const row = itemRow(stored("Done, all green.", { role: "assistant" }));
  expect(row.role).toBe("assistant");
  expect(row.type).toBe("message");
  expect(row.text).toBe("Done, all green.");
});

test("a thread row names its pull request and, while working, when the stretch began", () => {
  const working = ThreadListEntry.parse({
    id: "t1",
    workspaceId: "ace",
    title: "Fix the flaky queue test",
    provider: "claude",
    createdAt: 0,
    updatedAt: 10,
    status: { state: "working", agents: 1 },
    live: { workingSince: 5 },
    details: { branch: "fix/queue", linkedPr: { number: 1188, state: "open", draft: true } },
  });
  expect(threadRow(working)).toMatchObject({
    branch: "fix/queue",
    pr: { number: 1188, state: "draft" },
    workingSince: 5,
  });
  const finished = ThreadListEntry.parse({ ...working, status: { state: "done" } });
  expect(threadRow(finished)).toMatchObject({ pr: { number: 1188 }, workingSince: null });
  const bare = ThreadListEntry.parse({ ...working, details: undefined });
  expect(threadRow(bare).pr).toBeNull();
});
