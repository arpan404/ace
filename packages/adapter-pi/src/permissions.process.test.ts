import { expect, test } from "vitest";
import { sessionHarness } from "./testing/harness.ts";

test.each(["auto-review", "ask", "read-only", "full-access"] as const)(
  "Pi %s launches with the selected native tools and never falls back to full access",
  async (mode) => {
    const expected = mode === "full-access" ? "write available" : "write unavailable";
    const h = await sessionHarness({}, false, {}, undefined, mode);
    try {
      await h.session.send([{ type: "text", text: "write-proof" }], "queue");
      await h.wait((f) => f.dir === "recv" && JSON.stringify(f.data).includes(expected));
      expect(
        Object.values(h.h.state.items).some((item) => JSON.stringify(item).includes(expected)),
      ).toBe(true);
      await h.session.send([{ type: "text", text: "tools-proof" }], "queue");
      const proof = JSON.stringify({
        tools: mode === "full-access" ? "all" : ["read", "grep", "find", "ls"],
        ambientExtensions: mode === "full-access",
      });
      const observed = await h.wait(
        (f) =>
          f.dir === "recv" && JSON.stringify(f.data).includes(JSON.stringify(proof).slice(1, -1)),
      );
      expect(JSON.stringify(observed.data)).toContain(JSON.stringify(proof).slice(1, -1));
    } finally {
      await h.dispose();
    }
  },
);
