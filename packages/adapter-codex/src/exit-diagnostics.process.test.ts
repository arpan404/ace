import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

test("a native crash retains bounded redacted stderr and exit code in diagnostic evidence", async () => {
  const h = await sessionHarness(false, "exit-diagnostic");
  try {
    await h.session.send([{ type: "text", text: "exit" }], "steer");
    const exit = await h.exited;
    const diagnostic = obj(
      h.frames.find((f) => f.dir === "note" && obj(f.data).event === "codex-session-exit")?.data,
    );
    expect(diagnostic).toMatchObject({
      deliberate: false,
      reason: "exit",
      code: 7,
      signal: null,
      generation: "offline-session",
      retirement: null,
    });
    expect(String(diagnostic.stderr)).toContain("offline app-server failure");
    expect(String(diagnostic.stderr)).not.toContain("super-secret-test-token");
    expect(new TextEncoder().encode(String(diagnostic.stderr)).length).toBeLessThanOrEqual(4096);
    expect(exit.deliberate).toBe(false);
  } finally {
    await h.dispose();
  }
});

test.each(["idle", "user", "shutdown"] as const)(
  "a deliberate %s retirement has a distinct reason and signal",
  async (reason) => {
    const h = await sessionHarness();
    try {
      await h.session.close(reason);
      await h.exited;
      expect(
        h.frames.map((f) => obj(f.data)).find((d) => d.event === "codex-session-exit"),
      ).toMatchObject({ deliberate: true, retirement: reason, generation: "offline-session" });
      expect(h.exits[0]?.message).toContain(reason);
    } finally {
      await h.dispose();
    }
  },
);
