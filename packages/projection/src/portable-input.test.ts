import { expect, test } from "vitest";
import { PortableHandoff, type ContentPart } from "@ace/protocol";
import { withoutPortableHandoff } from "./index.ts";

const handoff = PortableHandoff.parse({
  version: 1,
  sourceThreadId: "earlier-thread",
  throughSeq: 10,
  lossy: true,
  policy: "recent-complete-items",
  excerpts: [],
  omittedItems: 0,
  history: { type: "items.page", threadId: "earlier-thread", before: 11, limit: 50 },
  limitations:
    "Provider-private state is unavailable. Page history for omitted items, full text, reasoning, tools and attachments.",
});

for (const { name, envelope } of [
  { name: "compact", envelope: JSON.stringify(handoff) },
  { name: "pretty", envelope: JSON.stringify(handoff, null, 2) },
]) {
  test(`a ${name} handoff joined to a user message preserves only their input`, () => {
    const attachment: ContentPart = { type: "text", text: "A second part" };
    expect(
      withoutPortableHandoff([{ type: "text", text: `${envelope}\n\nhi` }, attachment]),
    ).toEqual([{ type: "text", text: "hi" }, attachment]);
    expect(withoutPortableHandoff([{ type: "text", text: envelope }, attachment])).toEqual([
      attachment,
    ]);
  });
}

test("ordinary user JSON and an invalid handoff remain visible", () => {
  for (const text of ['{"version":1,"task":"hello"}hi', '{"version":1,"sourceThreadId":"x"']) {
    expect(withoutPortableHandoff([{ type: "text", text }])).toEqual([{ type: "text", text }]);
  }
});
