import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { backendFixture } from "./backend-test-support.ts";
import { detectChromium } from "./discovery.ts";

const executablePath = process.env.ACE_CHROMIUM_PATH ?? (await detectChromium());

it.skipIf(!executablePath)(
  "a page moved off a locked desktop reaches its site signed in, from its first request",
  async () => {
    const cookies: string[] = [];
    const server = createServer((request, response) => {
      if (request.url === "/account") cookies.push(request.headers.cookie ?? "");
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>Account</title><p>Account</p>");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    try {
      // The fake desktop hosts the page; ace's real Chromium takes it when the screen locks.
      const f = await backendFixture(
        { ...(executablePath ? { executablePath } : {}), tabLifecycle: false, ffmpeg: "" },
        { realHeadless: true },
      );
      const url = `http://localhost:${address.port}/account`;
      await f.service.open({ threadId: "thread", workspaceId: "workspace", profile: "ephemeral" });
      await f.service.execute("thread", { action: "navigate", url });
      const desktop = [...f.pages.values()][0];
      if (!desktop) throw new Error("Missing desktop page");
      desktop.signIns = [
        { name: "sid", value: "signed-in", domain: "localhost", hostOnly: true, path: "/" },
      ];
      const moved = Promise.withResolvers<void>();
      f.service.subscribe("thread", "viewer", {}, (state) => {
        if (state.backend === "headless" && state.status === "ready") moved.resolve();
      });
      f.service.desktopDrawable(false);
      await moved.promise;
      await expect.poll(() => cookies.length, { timeout: 20_000 }).toBeGreaterThan(0);
      expect(cookies).toEqual(cookies.map(() => "sid=signed-in"));
      expect(f.service.state("thread")).toMatchObject({ backend: "headless", url });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  },
  60_000,
);
