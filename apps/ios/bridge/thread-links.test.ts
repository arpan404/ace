import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { ItemId, ThreadId } from "@ace/protocol";
import { connect, fixture, open, reset, rows, until } from "./thread-harness.ts";

/*
 * ace's inputs that point at another thread reach the phone as rows naming that thread, as the
 * web draws them: a handoff's task card ("Handoff", the task, Back to the thread it came from)
 * and a merged fork's line ("Merged from" the fork, its summary behind it). Never the person's
 * bubble. Over the real SDK and the fake daemon; no provider CLI runs.
 */

afterEach(reset);

interface Event {
  kind: string;
  text: string;
  note: string;
  detail: string;
  threadId?: string;
}
const eventOf = (kind: string): Event | undefined =>
  rows("thread.block")
    .map((row) => row.event as Event | null | undefined)
    .find((event): event is Event => event?.kind === kind);

interface Origin {
  kind: "spawn" | "automation";
  role?: string;
  parentThreadId?: ThreadId;
}
const said = (id: string, text: string, origin: Origin) => ({
  type: "item.upsert" as const,
  agent: "root",
  item: id,
  draft: {
    type: "message" as const,
    role: "user" as const,
    synthetic: true,
    complete: true,
    parts: [{ type: "text" as const, text }],
    origin,
  },
});

test("a handoff opens its thread as a task card linking back to the thread it came from", async () => {
  const fake = fixture();
  fake.createThread({ id: "carried", workspaceId: "ace", title: "Carried", provider: "claude" });
  fake.apply("carried", [
    facts.rootAgent("claude"),
    said("task", "Role: handoff: release\n\nTask:\nShip the release notes.", {
      kind: "spawn",
      role: "handoff: release",
      parentThreadId: ThreadId.parse("earlier"),
    }),
  ]);
  open(connect(fake), "carried");
  const card = await until(() => eventOf("task"), "the task card");
  expect(card.text).toBe("Handoff");
  expect(card.detail).toBe("Ship the release notes.");
  expect(card.threadId).toBe("earlier");
  expect(rows("thread.block").some((row) => row.kind === "user")).toBe(false);
});

test("an automation's prompt is a task card with no thread to go back to", async () => {
  const fake = fixture();
  fake.createThread({ id: "nightly", workspaceId: "ace", title: "Nightly", provider: "claude" });
  fake.apply("nightly", [
    facts.rootAgent("claude"),
    said("task", "Check the build.", { kind: "automation" }),
  ]);
  open(connect(fake), "nightly");
  const card = await until(() => eventOf("task"), "the task card");
  expect(card.text).toBe("Automation");
  expect(card.detail).toBe("Check the build.");
  expect(card.threadId ?? "").toBe("");
});

test("a merged fork reads as Merged from the fork, with its summary and whether code came too", async () => {
  const fake = fixture();
  fake.createThread({ id: "main", workspaceId: "ace", title: "Main", provider: "claude" });
  fake.apply("main", [
    facts.rootAgent("claude"),
    {
      type: "item.upsert",
      agent: "root",
      item: "merge",
      draft: {
        type: "message",
        role: "user",
        synthetic: true,
        complete: true,
        parts: [{ type: "text", text: "Merged context" }],
        mergedContext: {
          sourceThreadId: ThreadId.parse("fork"),
          summary: "The fork fixed the export.",
          citations: [{ threadId: ThreadId.parse("fork"), itemId: ItemId.parse("answer") }],
          patchApplied: true,
        },
      },
    },
  ]);
  open(connect(fake), "main");
  const line = await until(() => eventOf("merged"), "the merged line");
  expect(line.text).toBe("Merged from");
  expect(line.threadId).toBe("fork");
  expect(line.detail).toBe("The fork fixed the export.");
  expect(line.note).toBe("Code changes included");
  expect(rows("thread.block").some((row) => row.kind === "user")).toBe(false);
});
