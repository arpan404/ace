import { describe, expect, it } from "vitest";
import type { ContentPart, MessageContext } from "@ace/protocol";
import { editedContext } from "./edited-context.ts";

const shot = "a".repeat(64);
const notes = "b".repeat(64);
const text = (value: string): ContentPart[] => [{ type: "text", text: value }];
const old = {
  input: text("look here"),
  context: { mentions: [], attachments: [{ sha256: shot, at: 5 }, { sha256: notes }] },
} satisfies { input: ContentPart[]; context: MessageContext };

describe("a person editing a queued message", () => {
  it("sends the files after new text when the edit carries the old context", () => {
    expect(editedContext(old, text("something else"), old.context)?.attachments).toEqual([
      { sha256: shot },
      { sha256: notes },
    ]);
  });

  it("keeps each file's spot when the text is unchanged", () => {
    expect(editedContext(old, text("look here"), old.context)).toEqual(old.context);
  });

  it("keeps the spots a new context sets for the new text", () => {
    const moved: MessageContext = { mentions: [], attachments: [{ sha256: shot, at: 2 }] };
    expect(editedContext(old, text("something else"), moved)).toEqual(moved);
  });

  it("leaves an edit without context without one", () => {
    expect(editedContext(old, text("something else"), undefined)).toBeUndefined();
  });
});
