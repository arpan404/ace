import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { BrowserService } from "./index.ts";
import type { BrowserDownloadProgress } from "@ace/protocol";

// Deliberately unskipped. Merge needs the pinned artifact and host Chromium dependencies;
// absence is a setup failure, rather than silent fallback to a personal installation.
it("an ace-owned first-use headless browser preserves the public policy, ref, screenshot, log and lease contract", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-owned-browser-"));
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      '<!doctype html><input aria-label="Name"><script>console.log("owned-marker")</script>',
    );
  });
  const progress: BrowserDownloadProgress["phase"][] = [];
  let approved = false;
  const service = new BrowserService({
    dataDir: home,
    evaluatePolicy: () => approved,
    onDownload: (event) => progress.push(event.phase),
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local address");
    const url = `http://127.0.0.1:${address.port}`;
    expect(
      await service.open({ threadId: "thread", workspaceId: "workspace", headed: true }),
    ).toMatchObject({ backend: "headless", status: "ready" });
    expect(progress).toEqual(
      expect.arrayContaining(["downloading", "verifying", "extracting", "ready"]),
    );
    expect(await readdir(join(home, "chromium"))).toHaveLength(1);
    await service.execute("thread", { action: "navigate", url });
    const snapshot = z.object({
      nodes: z.array(z.object({ name: z.string(), ref: z.string().optional() })),
    });
    const ref = snapshot
      .parse(await service.execute("thread", { action: "snapshot" }))
      .nodes.find((node) => node.name === "Name" && node.ref)?.ref;
    if (!ref) throw new Error("Missing textbox ref");
    await service.execute("thread", { action: "type", ref, text: "agent" });
    await expect(
      service.execute("thread", {
        action: "evaluate",
        expression: "document.querySelector('input').value",
      }),
    ).rejects.toThrow("approval");
    await expect(
      service.execute("thread", { action: "navigate", url: "https://example.invalid" }),
    ).rejects.toThrow("approval");
    approved = true;
    expect(
      await service.execute("thread", {
        action: "evaluate",
        expression: "document.querySelector('input').value",
      }),
    ).toBe("agent");
    service.takeover("thread", "human");
    await expect(service.execute("thread", { action: "scroll", x: 0, y: 1 })).rejects.toThrow(
      "controlled by human",
    );
    await service.input(
      "thread",
      { kind: "key", event: "char", text: " human", key: " " },
      "human",
    );
    service.handback("thread", "human");
    expect(
      await service.execute("thread", {
        action: "evaluate",
        expression: "document.querySelector('input').value",
      }),
    ).toBe("agent human");
    const image = z
      .object({ path: z.string() })
      .parse(await service.execute("thread", { action: "screenshot" }));
    expect((await readFile(image.path)).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const logs = z
      .object({ console: z.string() })
      .parse(await service.execute("thread", { action: "logs" }));
    expect(await readFile(logs.console, "utf8")).toContain("owned-marker");
    await service.execute("thread", { action: "navigate", url });
    await expect(service.execute("thread", { action: "type", ref, text: "stale" })).rejects.toThrow(
      "ref",
    );
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 660_000);
