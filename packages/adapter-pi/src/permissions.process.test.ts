import { expect, test } from "vitest";
import { PermissionMode } from "@ace/protocol";
import { sessionHarness } from "./testing/harness.ts";

test.each(
  ["auto-review", "ask", "read-only", "full-access"].flatMap((mode) =>
    [false, true].map((resume) => ({ mode, resume })),
  ),
)(
  "Pi $mode (resume=$resume) launches with the selected native tools and never falls back to full access",
  async ({ mode, resume }) => {
    const expected = mode === "full-access" ? "write available" : "write unavailable";
    const h = await sessionHarness({}, resume, {}, undefined, PermissionMode.parse(mode));
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
