import { expect, it } from "vitest";
import { Item } from "@ace/protocol";
import { transcriptRowContent } from "./transcript-row.ts";

function visualization(title: string) {
  return Item.parse({
    id: "html-1",
    agentId: "agent",
    createdAt: 0,
    complete: true,
    type: "html",
    visualization: {
      title,
      document: {
        sha256: "a".repeat(64),
        bytes: 128,
        mimeType: "text/html",
        name: "visualization.html",
      },
    },
  });
}

it("shows an HTML visualization's title with the view-elsewhere fallback", () => {
  const row = transcriptRowContent(visualization("Latency by region"));
  expect(row.text).toBe("Latency by region");
  expect(row.detail).toBe("Visualization — view on desktop or web");
  expect(row.quiet).toBe(true);
  expect(row.user).toBe(false);
});
