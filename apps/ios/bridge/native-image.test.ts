import { facts, fixtureImage } from "@ace/fake-daemon";
import { ItemId, ThreadId, type Attachment } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { readNativeImage } from "./native-image.ts";
import { connect, fixture, open, reset, rows, until } from "./thread-harness.ts";

/*
 * An image an agent's answer names draws in the answer when the thread itself captured it: the
 * daemon resolves the reference to the picture a tool read before the answer, and only those
 * bytes reach the phone. Anything else stays the image's alt text. No provider CLI runs.
 */

afterEach(reset);

const png = Buffer.from(fixtureImage.data, "base64");
const chart: Attachment = {
  sha256: fixtureImage.sha256,
  bytes: png.length,
  mimeType: "image/png",
  name: "chart.png",
  kind: "image",
  width: 640,
  height: 480,
  thumbnailAvailable: true,
};

async function answerNamingChart() {
  const fake = fixture();
  fake.createThread({ id: "charts", workspaceId: "ace", title: "Charts", provider: "codex" });
  fake.apply("charts", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Plot the latency."),
    facts.tool("root", "look", {
      kind: "image",
      title: "Viewed chart.png",
      detail: { kind: "image", path: "./chart.png", attachment: chart },
    }),
    facts.toolDone("root", "look"),
    facts.message("root", "answer", "assistant", "Latency fell:\n\n![chart](./chart.png)"),
  ]);
  fake.seedServices({ attachmentImages: [{ threadId: "charts", name: "chart.png" }] });
  const owner = connect(fake);
  open(owner, "charts");
  const row = await until(
    () => rows("thread.item").find((item) => item.role === "assistant"),
    "the answer",
  );
  const read = (reference: string) =>
    readNativeImage(
      owner,
      {
        type: "native.image",
        threadId: ThreadId.parse("charts"),
        itemId: ItemId.parse(String(row.id)),
        reference,
      },
      new AbortController().signal,
    );
  return { read };
}

test("an image the answer names draws from the picture its thread captured", async () => {
  const { read } = await answerNamingChart();
  const image = await read("./chart.png");
  expect(image.mimeType).toBe("image/png");
  expect(Buffer.from(image.data, "base64").equals(png)).toBe(true);
});

test("an image the thread never captured stays unresolved, never fetched", async () => {
  const { read } = await answerNamingChart();
  await expect(read("https://example.com/tracker.png")).rejects.toThrow();
  await expect(read("./other.png")).rejects.toThrow();
});
