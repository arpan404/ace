import { facts, fixtureImage, typedMeasurementCall } from "@ace/fake-daemon";
import type { StepMeasurement } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const urls = new Map<string, Blob>();
const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
beforeEach(() => {
  localStorage.clear();
  let id = 0;
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    const url = `blob:measurement/${++id}`;
    if (blob instanceof Blob) urls.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url: string) => void urls.delete(url);
});
afterEach(() => {
  URL.createObjectURL = original.create;
  URL.revokeObjectURL = original.revoke;
  urls.clear();
});

const measurement: StepMeasurement = {
  source: "screen-frames",
  target: { kind: "window", bundleId: "com.apple.Safari", windowId: 1 },
  refreshHz: 60,
  windowMs: 2000,
  frames: 100,
  latencyMs: 25,
  hitches: [],
  verdict: "janky",
  confidence: "high",
  notes: [],
  filmstrip: {
    sha256: fixtureImage.sha256,
    mimeType: "image/png",
    name: "filmstrip.png",
    bytes: atob(fixtureImage.data).length,
    width: 120,
    height: 80,
    thumbnailAvailable: true,
  },
};

async function openTyped(mode: "claude" | "custom" | "standalone") {
  const app = harness();
  app.daemon.createThread({
    id: "thread-evidence",
    workspaceId: "shop",
    title: "Measured interaction",
    provider: "claude",
  });
  app.daemon.seedServices({ attachmentImages: [{ threadId: "thread-evidence" }] });
  const seed = typedMeasurementCall("root", "measurement", measurement);
  if (seed.type !== "item.upsert" || seed.draft.type !== "tool_call") throw new Error("Wrong seed");
  if (mode === "custom")
    seed.draft.call = {
      ...seed.draft.call,
      kind: "custom",
      detail: { kind: "custom" },
      raw: [{ type: "native", blobRef: "large-result", size: 90000, preview: "" }],
    };
  if (mode === "claude")
    seed.draft.call = {
      ...seed.draft.call,
      raw: [
        {
          type: "assistant",
          data: {
            message: {
              content: [
                { type: "tool_use", name: "mcp__ace__screen_measure_interaction", input: {} },
              ],
            },
          },
        },
      ],
    };
  app.daemon.apply("thread-evidence", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "request", "user", "Measure scrolling"),
    mode === "standalone"
      ? {
          type: "item.upsert",
          agent: "root",
          item: "measurement",
          draft: {
            type: "notice",
            complete: true,
            level: "info",
            text: "Measured smoothness",
            measurement,
            raw: [],
          },
        }
      : seed,
    facts.endTurn("root"),
  ]);
  await app.open("/t/thread-evidence");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.click(await within(feed).findByRole("button", { name: /^Worked for/ }));
  const steps = await within(feed).findByRole("list", { name: "Steps" });
  await userEvent.click(
    await within(steps).findByRole("button", {
      name: /^Measured smoothness: Watched Safari Janky/,
    }),
  );
  return within(steps).findByRole("region", { name: "Smoothness: Watched Safari" });
}

for (const mode of ["claude", "custom", "standalone"] as const)
  test(`${mode} evidence renders the card and reads the filmstrip through its owning daemon`, async () => {
    const card = await openTyped(mode);
    expect(within(card).getByText("Janky")).toBeTruthy();
    expect(within(card).getByText("25 ms")).toBeTruthy();
    const thumbnail = await within(card).findByRole("img", { name: "Filmstrip" });
    await waitFor(() =>
      expect(urls.get(thumbnail.getAttribute("src") ?? "")?.size).toBe(
        measurement.filmstrip?.bytes,
      ),
    );
    await userEvent.click(within(card).getByRole("button", { name: "Filmstrip" }));
    const lightbox = await screen.findByRole("dialog", { name: "Filmstrip" });
    const image = within(lightbox).getByRole("img", { name: "Filmstrip" });
    await waitFor(() => expect(urls.get(image.getAttribute("src") ?? "")?.type).toBe("image/png"));
  });
