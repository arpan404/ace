import { expect, it } from "vitest";
import { OpenCodeServer } from "./index.ts";
import { object } from "./data.ts";
it.skipIf(process.env.ACE_LIVE_CLI !== "1")(
  "handshakes with the installed server without creating a session",
  async () => {
    const server = new OpenCodeServer();
    try {
      await server.ready();
      const health = object(
        await server.request(
          "GET",
          "/global/health",
          process.cwd(),
          undefined,
          () => {},
          new AbortController().signal,
        ),
      );
      expect(health.healthy).toBe(true);
      expect(health.version).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      await server.close();
    }
  },
);
