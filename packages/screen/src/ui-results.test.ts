import { expect, it } from "vitest";
import { windowsFixture } from "./testing/windows-fixture.ts";
it.each(["nodes", "depth", "findChildren", "findCount", "states"])(
  "public UI reads reject %s invalid or over-limit helper replies",
  async (mode) => {
    const f = await windowsFixture({ env: { UI_MODE: mode } });
    try {
      const session = await f.start();
      f.manager.controller(session.sessionId, "agent", "reader");
      if (mode === "findChildren")
        await expect(
          f.manager.uiFind(session.sessionId, { query: {}, limit: 2 }, "reader"),
        ).rejects.toThrow("caps");
      else if (mode === "findCount")
        await expect(
          f.manager.uiFind(session.sessionId, { query: {}, limit: 1 }, "reader"),
        ).rejects.toThrow();
      else if (mode === "states")
        await expect(
          f.manager.uiTree(session.sessionId, { maxNodes: 2, maxDepth: 5 }, "reader"),
        ).rejects.toThrow();
      else
        await expect(
          f.manager.uiTree(
            session.sessionId,
            { maxNodes: 2, maxDepth: mode === "depth" ? 0 : 5 },
            "reader",
          ),
        ).rejects.toThrow("caps");
      expect(f.manager.state(session.sessionId).lifecycle).toBe("live");
    } finally {
      await f.close();
    }
  },
);
