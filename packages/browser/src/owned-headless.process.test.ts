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
it("an ace-owned first-use headless browser preserves the public policy, ref, screenshot and log contract", async () => {
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
    ).rejects.toThrow("refused");
    approved = true;
    expect(
      await service.execute("thread", {
        action: "evaluate",
        expression: "document.querySelector('input').value",
      }),
    ).toBe("agent");
    await service.input(
      "thread",
      { kind: "key", event: "char", text: " human", key: " " },
      "human",
    );
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
      .object({ entries: z.array(z.object({ text: z.string() })) })
      .parse(await service.execute("thread", { action: "logs" }));
    expect(logs.entries.some((entry) => entry.text.includes("owned-marker"))).toBe(true);
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

// Windows ARM64 has no Chrome for Testing build. With no Chrome or Edge ace can drive (here,
// installed browsers are hidden from discovery), first use downloads the pinned x64 build,
// verified as on every platform, and runs it under Windows' emulation.
it.runIf(process.platform === "win32" && process.arch === "arm64")(
  "Windows ARM64: with no browser ace can drive, first use downloads the pinned x64 Chrome for Testing and drives it",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ace-owned-arm-"));
    const hidden = await mkdtemp(join(tmpdir(), "ace-no-browsers-"));
    const saved = Object.fromEntries(
      // Only where CI's Chrome is installed: Chrome inherits this environment, and the
      // emulated x64 build needs its own PATH and LOCALAPPDATA.
      ["PROGRAMFILES", "PROGRAMFILES(X86)"].map((key) => [key, process.env[key]]),
    );
    for (const key of Object.keys(saved)) process.env[key] = hidden;
    // CI names its own Chrome; first use here must find none.
    const named = process.env.ACE_CHROMIUM_PATH;
    delete process.env.ACE_CHROMIUM_PATH;
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end('<!doctype html><input aria-label="Name">');
    });
    const progress: BrowserDownloadProgress["phase"][] = [];
    const service = new BrowserService({
      dataDir: home,
      onDownload: (event) => progress.push(event.phase),
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing local address");
      expect(await service.open({ threadId: "thread", workspaceId: "workspace" })).toMatchObject({
        backend: "headless",
        status: "ready",
      });
      expect(progress).toEqual(
        expect.arrayContaining(["downloading", "verifying", "extracting", "ready"]),
      );
      expect(await readdir(join(home, "chromium"))).toHaveLength(1);
      await service.execute("thread", {
        action: "navigate",
        url: `http://127.0.0.1:${address.port}`,
      });
      const names = z
        .object({ nodes: z.array(z.object({ name: z.string() })) })
        .parse(await service.execute("thread", { action: "snapshot" }))
        .nodes.map((node) => node.name);
      expect(names).toContain("Name");
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      if (named !== undefined) process.env.ACE_CHROMIUM_PATH = named;
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      await rm(hidden, { recursive: true, force: true });
    }
  },
  300_000,
);
