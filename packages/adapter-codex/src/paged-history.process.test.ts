import { expect, test } from "vitest";
import { maxProviderPayloadBytes } from "@ace/provider-kit/payload";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

const texts = (h: Awaited<ReturnType<typeof sessionHarness>>) =>
  Object.values(h.replay.state.items).flatMap((item) =>
    item.type === "message"
      ? item.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );
const shows = (shown: string[], prefix: string) => shown.some((text) => text.startsWith(prefix));

/** The newest four of the fixture's 42 turns: messages 38 and 39, the split turn, and the last. */
function expectNewestTurns(h: Awaited<ReturnType<typeof sessionHarness>>) {
  const shown = texts(h);
  for (const index of [38, 39])
    expect(shows(shown, `message ${index} history`), `message ${index}`).toBe(true);
  for (const index of [0, 1, 20, 37])
    expect(shows(shown, `message ${index} history`), `message ${index}`).toBe(false);
  for (const index of [0, 1, 2])
    expect(shows(shown, `split ${index} history`), `split ${index}`).toBe(true);
  expect(shows(shown, "kept")).toBe(true);
  // One message larger than any frame is left out and says so; the thread still opens.
  expect(shows(shown, "oversized")).toBe(false);
  expect(
    h.frames.some(
      (f) =>
        f.dir === "note" &&
        obj(f.data)["event"] === "thread-history-omitted" &&
        obj(f.data)["item"] === "oversized",
    ),
  ).toBe(true);
  for (const frame of h.frames)
    expect(Buffer.byteLength(JSON.stringify(frame.data))).toBeLessThanOrEqual(
      maxProviderPayloadBytes,
    );
}

test("resuming a long thread reads only the newest page", async () => {
  // About 7 MB of readable history in 42 turns: as one reply it exceeded the 1 MiB frame bound.
  const h = await sessionHarness(true, "long-history");
  try {
    const pages = h.frames.filter(
      (f) => f.dir === "send" && obj(f.data)["method"] === "thread/turns/list",
    );
    expect(pages).toHaveLength(1);
    expect(obj(obj(pages[0]?.data)["params"])).toMatchObject({ sortDirection: "desc", limit: 4 });
    const resume = h.frames.find(
      (f) => f.dir === "send" && obj(f.data)["method"] === "thread/resume",
    );
    expect(obj(obj(resume?.data)["params"])["excludeTurns"]).toBe(true);
    expectNewestTurns(h);

    // The reopened thread takes new work.
    await h.session.send([{ type: "text", text: "after history" }], "steer");
    await h.wait((f) => obj(f.data)["method"] === "turn/started");
  } finally {
    await h.dispose();
  }
});

test("a server without paged history still reopens a long thread with its newest turns", async () => {
  const h = await sessionHarness(true, "legacy-history");
  try {
    expectNewestTurns(h);
    await h.session.send([{ type: "text", text: "after history" }], "steer");
    await h.wait((f) => obj(f.data)["method"] === "turn/started");
  } finally {
    await h.dispose();
  }
});
