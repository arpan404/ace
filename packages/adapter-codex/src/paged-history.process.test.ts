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

test.each(["long-history", "legacy-history"])(
  "a thread whose history outgrows one frame reopens with all of it (%s)",
  async (mode) => {
    // About 7 MB of readable history: as one reply it exceeded the 1 MiB frame bound (#693).
    const h = await sessionHarness(true, mode);
    try {
      const shown = texts(h);
      for (let index = 0; index < 40; index++)
        expect(shows(shown, `message ${index} history`), `message ${index}`).toBe(true);
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

      // The reopened thread takes new work.
      await h.session.send([{ type: "text", text: "after history" }], "steer");
      await h.wait((f) => obj(f.data)["method"] === "turn/started");
    } finally {
      await h.dispose();
    }
  },
);
