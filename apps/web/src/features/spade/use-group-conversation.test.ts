import { describe, expect, test } from "vitest";
import { groupRefusal } from "./use-group-conversation.ts";

describe("a group's composer", () => {
  test("sends words, and refuses images, documents and recordings before anything is posted", () => {
    expect(groupRefusal({ text: "hi", images: [] })).toBeUndefined();
    const image = { data: "", ref: { sha256: "a", mediaType: "image/png", bytes: 1 } };
    expect(groupRefusal({ text: "", images: [image] })).toMatch(/words only/);
    const document = {
      name: "a.pdf",
      data: "",
      ref: {
        sha256: "b",
        name: "a.pdf",
        mediaType: "application/pdf",
        bytes: 3,
        pages: 1,
        sheets: undefined,
        chars: 5,
        cut: false,
      },
    };
    expect(groupRefusal({ text: "read", images: [], documents: [document] })).toMatch(/words only/);
    const voice = {
      data: "",
      mediaType: "audio/webm",
      ref: { sha256: "c", mediaType: "audio/webm", bytes: 9 },
    };
    expect(groupRefusal({ text: "said", images: [], voice })).toMatch(/words only/);
  });
});
