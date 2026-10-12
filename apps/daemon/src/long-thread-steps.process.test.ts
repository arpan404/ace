import { expect, test } from "vitest";
import { Item, RawPayload } from "@ace/protocol";
import {
  agentMessage,
  end,
  root,
  start,
  storeFixture,
  tool,
  userMessage,
} from "./long-thread-test-support.ts";

function browse(id: string, url: string | undefined, runId: string) {
  return Item.parse({
    id,
    agentId: root,
    type: "tool_call",
    complete: true,
    createdAt: 1,
    runId,
    call: {
      id,
      agentId: root,
      kind: "mcp",
      title: id,
      status: "succeeded",
      startedAt: 1,
      detail: {
        kind: "mcp",
        server: "ace",
        tool: "ace_browser_open",
        arguments: url ? { url } : {},
      },
      raw: [
        RawPayload.parse({ type: "tool_use", name: "browser", data: { huge: "x".repeat(4000) } }),
      ],
    },
  });
}

function twoTurns() {
  const f = storeFixture();
  f.store.appendEvents(f.thread.id, [{ type: "item.created", item: userMessage("ask-1") }], 20);
  start(f.store, f.thread, "first", 30);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool("read", "succeeded", { kind: "file.read", path: "a.ts" }, "first"),
      },
      { type: "item.created", item: browse("open", "https://github.com/arpan404/ace", "first") },
      { type: "item.created", item: browse("click", undefined, "first") },
      { type: "item.created", item: agentMessage("answer", "Done", "first") },
    ],
    40,
  );
  end(f.store, f.thread, "first", 50);
  f.store.appendEvents(f.thread.id, [{ type: "item.created", item: userMessage("ask-2") }], 60);
  start(f.store, f.thread, "second", 70);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool("later", "running", { kind: "shell", command: "bun run test" }, "second"),
      },
    ],
    80,
  );
  return f;
}

// Mutations: returning the person's message, another turn's steps or the native payloads.
// Not executed (tests run at merge).
test("a turn's steps come back in order without the ask, other turns or native payloads", () => {
  const f = twoTurns();
  const page = f.store.turnSteps({ threadId: f.thread.id, turnOrdinal: 1 });
  expect(page.steps.map((step) => step.item.id)).toEqual(["read", "open", "click", "answer"]);
  const open = page.steps.find((step) => step.item.id === "open")?.item;
  expect(open?.type === "tool_call" && open.call.raw).toEqual([]);
  expect(page.after).toBeNull();
  expect(page.endSeq).toBeGreaterThan(0);
  const second = f.store.turnSteps({ threadId: f.thread.id, turnOrdinal: 2 });
  expect(second.steps.map((step) => step.item.id)).toEqual(["later"]);
});

// Mutations: forgetting the cursor, or ending the turn's read at a full page.
test("a long turn reads page by page from the cursor until its end", () => {
  const f = twoTurns();
  const first = f.store.turnSteps({ threadId: f.thread.id, turnOrdinal: 1, limit: 2 });
  expect(first.steps.map((step) => step.item.id)).toEqual(["read", "open"]);
  expect(first.after).toBe(first.steps.at(-1)?.seq);
  const rest = f.store.turnSteps({
    threadId: f.thread.id,
    turnOrdinal: 1,
    limit: 2,
    after: first.after ?? 0,
  });
  expect(rest.steps.map((step) => step.item.id)).toEqual(["click", "answer"]);
  expect(rest.after).toBeNull();
});

// Mutations: not carrying the site forward, or looking an icon up on the read path.
test("browser steps name their site, carried to steps that name none, with a known icon", () => {
  const f = twoTurns();
  const asked: string[] = [];
  const page = f.store.turnSteps({ threadId: f.thread.id, turnOrdinal: 1 }, (icon) => {
    asked.push(icon.kind === "site" ? icon.origin : icon.identity);
    return icon.kind === "site" && icon.origin === "https://github.com"
      ? "a".repeat(64)
      : undefined;
  });
  const surfaces = Object.fromEntries(page.steps.map((step) => [step.item.id, step.surface]));
  expect(surfaces.open).toEqual({
    kind: "browser",
    icon: { kind: "site", origin: "https://github.com" },
    iconRef: "a".repeat(64),
  });
  expect(surfaces.click?.icon).toEqual({ kind: "site", origin: "https://github.com" });
  expect(surfaces.read).toBeUndefined();
  expect(asked).toEqual(["https://github.com", "https://github.com"]);
});

test("a turn the index has never seen is refused", () => {
  const f = twoTurns();
  expect(() => f.store.turnSteps({ threadId: f.thread.id, turnOrdinal: 9 })).toThrow(
    "turn_target_unavailable",
  );
});
