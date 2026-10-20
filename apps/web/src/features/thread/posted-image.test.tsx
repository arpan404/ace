import { facts, fixtureImage } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/* jsdom has no object URLs: stub them at that boundary, remembering each one's blob. */
const objectUrls = new Map<string, Blob>();
const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
beforeEach(() => {
  let next = 0;
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    const url = `blob:test/${++next}`;
    if (blob instanceof Blob) objectUrls.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url: string) => void objectUrls.delete(url);
});
afterEach(() => {
  URL.createObjectURL = original.create;
  URL.revokeObjectURL = original.revoke;
  objectUrls.clear();
});

const fixtureBytes = atob(fixtureImage.data).length;

test("an image the agent posted shows its own bytes in the reply, with its caption, and opens the lightbox", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "thread-plot",
    workspaceId: "shop",
    title: "Plot latency",
    provider: "codex",
  });
  app.daemon.seedServices({ attachmentImages: [{ threadId: "thread-plot", name: "plot.png" }] });
  app.daemon.apply("thread-plot", [
    facts.rootAgent("codex", "/work/shop"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Plot the latency"),
    {
      type: "item.upsert",
      agent: "root",
      item: "plot",
      draft: {
        type: "image",
        complete: true,
        image: {
          alt: "Latency by day",
          caption: "p95 latency, Monday to Sunday",
          attachment: {
            sha256: fixtureImage.sha256,
            bytes: fixtureBytes,
            mimeType: "image/png",
            name: "plot.png",
            kind: "image",
            width: 120,
            height: 80,
            thumbnailAvailable: true,
          },
        },
      },
    },
    facts.endTurn("root"),
  ]);
  await app.open("/t/thread-plot");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const image = await within(feed).findByRole("img", { name: "Latency by day" });
  expect(objectUrls.get(image.getAttribute("src") ?? "")?.size).toBe(fixtureBytes);
  expect(within(feed).getByText("p95 latency, Monday to Sunday")).toBeTruthy();
  const opener = image.closest("button");
  if (!opener) throw new Error("The image does not open");
  await userEvent.click(opener);
  expect(await screen.findByRole("dialog", { name: "Latency by day" })).toBeTruthy();
});
