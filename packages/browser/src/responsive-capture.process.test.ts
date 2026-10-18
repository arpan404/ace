import { readFile } from "node:fs/promises";
import { CredentialRegistry, ToolRegistry, nodeScheduler } from "@ace/mcp-server";
import { BrowserScreenshotSet, McpScope, type BrowserArtifact } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { imageSize } from "./image-size.ts";
import { browserToolkit } from "./index.ts";
import { executablePath, fixture } from "./test-support.ts";

const person = { kind: "human", connectionId: "person" } as const;
const metrics = "[innerWidth, innerHeight, devicePixelRatio].join('x')";

describe.skipIf(!executablePath)("multi-size screenshots in real Chrome", () => {
  it("a person's capture lays the page out at each width, keeps full-size PNGs and restores the tab", async () => {
    const published: BrowserArtifact[] = [];
    const f = await fixture({ onArtifact: (_thread, artifact) => void published.push(artifact) });
    await f.navigate();
    const before = await f.evaluate(metrics);
    const set = BrowserScreenshotSet.parse(
      await f.service.execute(
        "thread",
        { action: "screenshot", sizes: ["phone", "tablet", "desktop"] },
        person,
      ),
    );
    expect(set.images.map((image) => [image.size, image.width])).toEqual([
      ["phone", 390],
      ["tablet", 768],
      ["desktop", 1440],
    ]);
    // Each preview and each kept PNG really is the page at that width.
    for (const image of set.images) {
      const preview = imageSize(Buffer.from(image.data, "base64"));
      expect(preview).toEqual({ width: image.width, height: image.height });
      const png = imageSize(await readFile(image.path ?? ""));
      expect(png).toEqual({ width: image.width, height: image.height });
    }
    expect(published.map((artifact) => artifact.mimeType)).toEqual([
      "image/png",
      "image/png",
      "image/png",
    ]);
    // The tab is back at its own size and density.
    expect(await f.evaluate(metrics)).toBe(before);
  }, 90_000);

  it("a device the tab was emulating comes back after the capture", async () => {
    const f = await fixture();
    await f.navigate();
    const before = await f.evaluate(metrics);
    await f.service.execute(
      "thread",
      { action: "emulate", width: 600, height: 700, deviceScaleFactor: 2, mobile: true },
      person,
    );
    const emulated = await f.evaluate(metrics);
    expect(emulated).not.toBe(before);
    await f.service.execute("thread", { action: "screenshot", sizes: ["desktop"] }, person);
    expect(await f.evaluate(metrics)).toBe(emulated);
  }, 90_000);

  it("an agent's ace_browser_screenshot with sizes returns one labelled image per size", async () => {
    const f = await fixture();
    await f.navigate();
    const before = await f.evaluate(metrics);
    const registry = new ToolRegistry({ scheduler: nodeScheduler });
    browserToolkit(f.service).register(registry);
    const credentials = new CredentialRegistry(() => "b".repeat(64));
    const lease = credentials.issue(
      McpScope.parse({
        sessionId: "provider",
        threadId: "thread",
        agentId: "root",
        capabilities: ["browser"],
      }),
      new AbortController().signal,
    );
    try {
      const result = z
        .object({
          content: z.array(
            z.union([
              z.object({ type: z.literal("text"), text: z.string() }),
              z.object({ type: z.literal("image"), mimeType: z.string(), data: z.string() }),
            ]),
          ),
        })
        .parse(
          await registry.call(
            "ace_browser_screenshot",
            { sizes: ["phone", "desktop"] },
            lease.principal,
            new AbortController().signal,
          ),
        );
      const images = result.content.flatMap((part) =>
        part.type === "image" ? [imageSize(Buffer.from(part.data, "base64"))?.width] : [],
      );
      expect(images).toEqual([390, 1440]);
      expect(result.content.flatMap((part) => (part.type === "text" ? [part.text] : []))).toEqual([
        expect.stringMatching(/^phone: 390×/),
        expect.stringMatching(/^desktop: 1440×/),
      ]);
      expect(await f.evaluate(metrics)).toBe(before);
    } finally {
      credentials.close();
    }
  }, 90_000);
});
