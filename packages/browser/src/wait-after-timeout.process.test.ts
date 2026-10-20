import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it, onTestFinished } from "vitest";
import { agentMcp } from "./agent-mcp-test-support.ts";
import { executablePath, fixture, toolPort } from "./test-support.ts";

/** A local site whose /slow page never answers: a dev server stuck mid-request. */
async function stuckSite(): Promise<string> {
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/slow") {
      held.push(response);
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Ready</title><h1>Ready page</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    for (const response of held) response.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}

describe.skipIf(!executablePath)("waiting after a page that loads too slowly", () => {
  it("a slow page fails as page_timeout, and the next wait gets its own time instead of failing at once", async () => {
    const f = await fixture();
    const site = await stuckSite();
    const agent = agentMcp(toolPort(f.service));
    await agent.ok("browser_open", { url: `${site}/` });
    const slow = await agent.failure("browser_open", { url: `${site}/slow`, timeout: 500 });
    // A slow page is not a refused site: no approval was involved.
    expect(slow.code).toBe("page_timeout");
    expect(JSON.stringify(slow)).not.toContain("blocked");
    const started = Date.now();
    const waited = await agent.call("browser_wait_for", { text: "Ready page", timeout: 5_000 });
    expect(waited.isError, JSON.stringify(waited)).toBeUndefined();
    const missing = await agent.failure("browser_wait_for", {
      text: "Never shown",
      timeout: 1_000,
    });
    expect(missing.code).toBe("timeout");
    // The wait used its timeout rather than failing on the earlier navigation's leftover.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  }, 60_000);
});
