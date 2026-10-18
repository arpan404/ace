import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { agentMcp, refNamed } from "./agent-mcp-test-support.ts";
import { imageSize } from "./image-size.ts";
import { executablePath, fixture, toolPort } from "./test-support.ts";

const Geometry = z.object({
  width: z.number(),
  height: z.number(),
  scale: z.number(),
  origin: z.object({ x: z.number(), y: z.number() }),
});

/** A site whose pages keep the network busy for a while after they load. */
async function busySite() {
  const server = createServer((request, response) => {
    if (request.url === "/slow") {
      setTimeout(() => response.end("slow-done"), 800);
      return;
    }
    response.setHeader("Content-Type", "text/html");
    if (request.url?.startsWith("/orders/")) {
      response.end("<!doctype html><title>Order</title><p>Order page</p>");
      return;
    }
    response.end(`<!doctype html><body>
      <a href="/orders/42?from=list">Open order</a>
      <button onclick="fetch('/slow').then(r=>r.text()).then(t=>window.saved=t)">Save</button>
      <script>addEventListener('load',()=>setTimeout(()=>fetch('/slow').then(r=>r.text()).then(t=>window.loaded=t),50))</script>
      </body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}

describe.skipIf(!executablePath)("browser tools agents can aim and pace", () => {
  it("a click computed from a downscaled screenshot's scale lands on what the image shows", async () => {
    const f = await fixture();
    await f.navigate();
    const agent = agentMcp(toolPort(f.service));
    await agent.ok("browser_settings", { action: "resize", width: 3200, height: 800 });
    await f.evaluate(
      `document.body.innerHTML = '<div role="group" aria-label="Pair" style="display:flex;width:3000px;height:120px"><button style="width:1500px" onclick="document.title=\\'Left\\'">Left</button><button style="width:1500px" onclick="document.title=\\'Right\\'">Right</button></div>'; 0`,
    );
    const pair = refNamed(agent.raw(await agent.ok("browser_snapshot")), "Pair");
    const shot = await agent.ok("browser_screenshot", { ref: pair });
    const geometry = Geometry.parse(agent.json(shot));
    // The 3000 CSS px group comes back narrower than it is; scale carries the difference.
    expect(geometry.width).toBeLessThan(3000);
    // Three quarters across the image is inside the right-hand button.
    await agent.ok("browser_act", {
      action: "click",
      x: geometry.origin.x + geometry.width * 0.75 * geometry.scale,
      y: geometry.origin.y + geometry.height * 0.5 * geometry.scale,
    });
    await expect(f.evaluate("document.title")).resolves.toBe("Right");
  });

  it("navigate with waitUntil networkidle returns only once the page's requests are done", async () => {
    const f = await fixture();
    const site = await busySite();
    const agent = agentMcp(toolPort(f.service));
    await agent.ok("browser_open", { url: `${site}/`, waitUntil: "networkidle", timeout: 10_000 });
    await expect(f.evaluate("window.loaded")).resolves.toBe("slow-done");
  });

  it("wait_for networkIdle waits out the requests a click started", async () => {
    const f = await fixture();
    const site = await busySite();
    const agent = agentMcp(toolPort(f.service));
    await agent.ok("browser_open", { url: `${site}/`, waitUntil: "networkidle" });
    const save = refNamed(agent.raw(await agent.ok("browser_snapshot")), "Save");
    await agent.ok("browser_act", { action: "click", ref: save });
    await agent.ok("browser_wait_for", { networkIdle: true });
    await expect(f.evaluate("window.saved")).resolves.toBe("slow-done");
  });

  it("wait_for url accepts a glob for a destination with an id and query", async () => {
    const f = await fixture();
    const site = await busySite();
    const agent = agentMcp(toolPort(f.service));
    await agent.ok("browser_open", { url: `${site}/` });
    await agent.ok("browser_act", {
      action: "click",
      ref: refNamed(agent.raw(await agent.ok("browser_snapshot")), "Open order"),
    });
    const waited = z
      .object({ url: z.string() })
      .parse(agent.json(await agent.ok("browser_wait_for", { url: `${site}/orders/*` })));
    expect(waited.url).toBe(`${site}/orders/42?from=list`);
    const wrong = await agent.failure("browser_wait_for", {
      url: `${site}/invoices/*`,
      timeout: 300,
    });
    expect(wrong.code).toBe("timeout");
  });

  it("wait_for timeMs pauses for that long", async () => {
    const f = await fixture();
    await f.navigate();
    const agent = agentMcp(toolPort(f.service));
    await f.evaluate("setTimeout(() => { window.settled = true }, 300); 0");
    await agent.ok("browser_wait_for", { timeMs: 600 });
    await expect(f.evaluate("window.settled")).resolves.toBe(true);
  });

  it("record_start records the background tab it is given, not the tab the person views", async () => {
    const f = await fixture();
    await f.navigate();
    const agent = agentMcp(toolPort(f.service));
    const viewed = f.service.state("thread").activeTabId;
    const opened = z
      .object({ tabId: z.string() })
      .parse(agent.json(await agent.ok("browser_tabs", { action: "open", url: f.url })));
    // The person keeps looking at their own tab.
    await f.service.execute(
      "thread",
      { action: "tabs", operation: "select", tabId: viewed },
      { kind: "human", connectionId: "person" },
    );
    expect(f.service.state("thread").activeTabId).not.toBe(opened.tabId);
    // A size no other tab has, so every recorded frame shows which tab it came from.
    await agent.ok("browser_settings", {
      action: "resize",
      tabId: opened.tabId,
      width: 900,
      height: 700,
    });
    await agent.ok("browser_settings", { action: "record_start", tabId: opened.tabId });
    await sleep(1_000);
    const artifact = z
      .object({ path: z.string() })
      .parse(agent.json(await agent.ok("browser_settings", { action: "record_stop" })));
    const dir = dirname(artifact.path);
    const frames = (await readdir(dir)).filter((name) => name.endsWith(".jpg"));
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames)
      expect(imageSize(await readFile(join(dir, frame)))).toMatchObject({ height: 700 });
  });
});
