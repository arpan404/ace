import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { Snapshot } from "./test-support.ts";
import { executablePath, fixture } from "./test-support.ts";

describe.skipIf(!executablePath)("approval lifetime across threads", () => {
  it("keeps timed-out hooks admitted until they settle and rejects another thread's approval", async () => {
    const closed = Promise.withResolvers<void>();
    const server = createServer((_request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.end();
      closed.resolve();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No closure observer");
    let approvals = 0;
    const uncooperative = Promise.withResolvers<boolean>();
    try {
      const f = await fixture({
        originPolicy: () => (++approvals <= 32 ? uncooperative.promise : false),
      });
      await f.navigate();
      await f.service.open({ threadId: "other", workspaceId: "other" });
      const socketUrl = JSON.stringify(
        f.url.replace("http:", "ws:").replace("127.0.0.1", "127.0.0.2"),
      );
      // Return before the approval deadline. Browser-side close notifications
      // report when all 32 policy callers have actually timed out.
      await f.evaluate(`let closed=0;for(let i=0;i<32;i++){
        const ws=new WebSocket(${socketUrl}+'/'+i);
        ws.onclose=()=>{if(++closed===32)fetch('http://127.0.0.1:${address.port}/closed')};
      }void 0`);
      await closed.promise;
      expect(approvals).toBe(32);
      await expect(
        f.service.execute("other", { action: "navigate", url: "https://example.invalid" }),
      ).rejects.toThrow("admission limit");
      expect(approvals).toBe(32);
      // Settlement, rather than caller expiry, releases the shared capacity.
      uncooperative.resolve(false);
      // A native CDP round trip lets settled-hook microtasks finish and proves
      // the existing page remains usable after caller expiry.
      const snapshot = Snapshot.parse(await f.execute({ action: "snapshot" }));
      expect(snapshot.nodes.some((node) => node.name === "Name" && node.role === "textbox")).toBe(
        true,
      );
      await expect(
        f.service.execute("other", { action: "navigate", url: "https://example.invalid" }),
      ).rejects.toThrow("Browser origin requires approval");
      expect(approvals).toBe(33);
    } finally {
      uncooperative.resolve(false);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});
