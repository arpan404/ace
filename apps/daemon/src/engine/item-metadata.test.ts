import { applyDelta } from "@ace/projection";
import { Item } from "@ace/protocol";
import { expect, it } from "vitest";
import { appendTarget, itemMetadata, unchangedByTextAppend } from "./item-metadata.ts";

const base = { id: "i", agentId: "a", createdAt: 1, complete: false };
const source = { streamId: "text:i", encoding: "utf-16le", bytes: 10 };
const items = {
  "a message ending in text": {
    ...base,
    type: "message",
    role: "assistant",
    parts: [{ type: "text", text: "Hi" }],
  },
  "a message ending in a sourced text": {
    ...base,
    type: "message",
    role: "assistant",
    parts: [{ type: "text", text: "Hi", source }],
  },
  "an empty message": { ...base, type: "message", role: "assistant", parts: [] },
  "a message ending in an image": {
    ...base,
    type: "message",
    role: "user",
    parts: [
      { type: "text", text: "see" },
      { type: "image", mimeType: "image/png", url: "file:///a.png" },
    ],
  },
  "a reasoning item": { ...base, type: "reasoning", text: "think" },
  "a sourced reasoning item": { ...base, type: "reasoning", text: "think", source },
  "a notice": { ...base, type: "notice", level: "info", text: "note" },
};

it.each(Object.entries(items))(
  "a text append on %s leaves its stored metadata as it was, and is called unchanged only when it is",
  (_name, input) => {
    const metadata = itemMetadata(Item.parse(input));
    const stored = JSON.stringify(metadata);
    const target = appendTarget(metadata);
    expect(applyDelta(target, "text", " more")).toBe(true);
    expect(JSON.stringify(metadata)).toBe(stored);
    const same = JSON.stringify(itemMetadata(target)) === stored;
    if (unchangedByTextAppend(metadata, target)) expect(same).toBe(true);
    if (!same) expect(unchangedByTextAppend(metadata, target)).toBe(false);
  },
);

it("plain text appends are recognised as leaving the metadata unchanged", () => {
  for (const name of ["a message ending in text", "a reasoning item", "a notice"] as const) {
    const metadata = itemMetadata(Item.parse(items[name]));
    const target = appendTarget(metadata);
    applyDelta(target, "text", " more");
    expect(unchangedByTextAppend(metadata, target)).toBe(true);
  }
});
