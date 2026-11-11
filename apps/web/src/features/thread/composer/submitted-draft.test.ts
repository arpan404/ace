import { insertAttachmentMarkers, withMarkerHashes } from "@ace/ui-core";
import { expect, test } from "vitest";
import { composerContent } from "./submitted-draft.ts";

test("the same bytes added twice go once, at the first place they were added", () => {
  const first = insertAttachmentMarkers("a b", [], 1, [{ key: 1, name: "x.png" }]);
  const second = insertAttachmentMarkers(first.text, first.tokens, first.text.length, [
    { key: 2, name: "x.png" },
  ]);
  const tokens = withMarkerHashes(second.tokens, [
    { key: 1, sha256: "same" },
    { key: 2, sha256: "same" },
  ]);
  const content = composerContent({
    text: second.text,
    tokens,
    mentions: [],
    attachments: [{ sha256: "same", name: "x.png" }],
  });
  expect(content.attachments).toEqual([{ sha256: "same", at: 1 }]);
});
