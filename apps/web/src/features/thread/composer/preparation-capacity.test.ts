import { expect, test } from "vitest";
import { memoryKeyValue } from "@/test/harness.tsx";
import { readDraft, writeDraft } from "./draft-store.ts";

test("preparation capacity refuses a new draft while preserving every accepted preparation", () => {
  const storage = memoryKeyValue();
  for (let index = 0; index < 50; index++)
    expect(
      writeDraft(storage, `new:["host","${index}",""]`, {
        text: `Preparation ${index}`,
        mentions: [],
        attachments: [],
      }),
    ).toBe(true);
  expect(
    writeDraft(storage, 'new:["host","overflow",""]', {
      text: "Keep this in the editor",
      mentions: [],
      attachments: [],
    }),
  ).toBe(false);
  expect(readDraft(storage, 'new:["host","0",""]')?.text).toBe("Preparation 0");
  expect(readDraft(storage, 'new:["host","49",""]')?.text).toBe("Preparation 49");
  expect(writeDraft(storage, 'new:["host","0",""]', undefined)).toBe(true);
  expect(
    writeDraft(storage, 'new:["host","overflow",""]', {
      text: "Now there is room",
      mentions: [],
      attachments: [],
    }),
  ).toBe(true);
  expect(readDraft(storage, 'new:["host","overflow",""]')?.text).toBe("Now there is room");
});
