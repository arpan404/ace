import type { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { retainedInputNotice, shortReason } from "./retained-input.ts";

test("the not-sent line keeps one short sentence of the reason", () => {
  expect(shortReason("Codex couldn't start. The CLI exited with code 1.")).toBe(
    "Codex couldn't start",
  );
  expect(shortReason("   ")).toBeUndefined();
  expect(shortReason("x".repeat(200))?.length).toBe(96);
});

const notice = (id: string, commandId: string, detail: string) =>
  ({ id, type: "notice", code: "input_queued", commandId, detail }) as unknown as Item;

test("the detail behind a kept message follows the daemon's newest notice for it", () => {
  const items = new Map<string, Item>([
    ["a", notice("a", "cmd-1", "first attempt")],
    ["b", notice("b", "cmd-2", "another message")],
    ["c", notice("c", "cmd-1", "second attempt")],
  ]);
  const transcript = { order: ["a", "b", "c"], item: (id: string) => items.get(id) };
  expect(retainedInputNotice(transcript, "cmd-1")?.detail).toBe("second attempt");
  expect(retainedInputNotice(transcript, "cmd-3")).toBeUndefined();
});
