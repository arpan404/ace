import { expect, test } from "vitest";
import { sessionHarness } from "./testing/harness.ts";

test.each([
  ["read_only", "write unavailable"],
  ["full-access", "write available"],
] as const)(
  "native %s controls Pi's actual tool selection without claiming the ace protected-read gate",
  async (mode, expected) => {
    const h = await sessionHarness(
      mode === "read_only" ? { permissionMode: mode } : {},
      false,
      {},
      undefined,
      mode === "full-access" ? mode : undefined,
    );
    try {
      await h.session.send([{ type: "text", text: "write-proof" }], "queue");
      await h.wait(
        (frame) => frame.dir === "recv" && JSON.stringify(frame.data).includes(expected),
      );
      expect(
        Object.values(h.h.state.items).some((item) => JSON.stringify(item).includes(expected)),
      ).toBe(true);
    } finally {
      await h.dispose();
    }
  },
);

test.each(["auto-review", "ask", "read-only"] as const)(
  "Pi rejects %s instead of opening unrestricted tools",
  async (mode) => {
    await expect(sessionHarness({}, false, {}, undefined, mode)).rejects.toThrow("cannot enforce");
  },
);
