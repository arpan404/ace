import { createServer } from "node:http";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { agentMcp, refNamed } from "./agent-mcp-test-support.ts";
import { chromeProcesses } from "./chrome-test-process.ts";
import { BrowserService } from "./index.ts";
import { executablePath, fixture, toolPort } from "./test-support.ts";

/** A loopback port nothing listens on: a dev server that is not running. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe.skipIf(!executablePath)("browser failures an agent can act on", () => {
  it("names the network error and asks whether the dev server runs when a page is unreachable", async () => {
    const f = await fixture();
    const agent = agentMcp(toolPort(f.service));
    const failure = await agent.failure("browser_open", {
      url: `http://127.0.0.1:${await closedPort()}/`,
    });
    expect(failure).toMatchObject({
      code: "page_unreachable",
      detail: "net::ERR_CONNECTION_REFUSED",
    });
    expect(failure.hint).toMatch(/dev server running/);
  });

  it("tells the agent the browser restarted when it uses a ref from before a Chrome crash", async () => {
    const f = await fixture();
    const agent = agentMcp(toolPort(f.service));
    await agent.ok("browser_open", { url: `${f.url}/?before` });
    const name = refNamed(agent.raw(await agent.ok("browser_snapshot")), "Name");
    const { browser } = await chromeProcesses(f.home);
    if (!browser) throw new Error("Browser process missing");
    process.kill(browser, "SIGKILL");
    await vi.waitFor(async () => expect(await f.evaluate("location.search")).toBe("?before"), {
      timeout: 30_000,
      interval: 200,
    });
    const failure = await agent.failure("browser_act", { action: "type", ref: name, text: "lost" });
    expect(failure.code).toBe("browser_restarted");
    expect(failure.hint).toMatch(/fresh snapshot/);
    // A fresh snapshot is the way back.
    const fresh = refNamed(agent.raw(await agent.ok("browser_snapshot")), "Name");
    await agent.ok("browser_act", { action: "type", ref: fresh, text: "after restart" });
  }, 60_000);

  it("explains a recording that was never started or is already running", async () => {
    const f = await fixture();
    await f.navigate();
    const agent = agentMcp(toolPort(f.service));
    const stop = { action: "record_stop" };
    expect((await agent.failure("browser_settings", stop)).code).toBe("recording_inactive");
    await agent.ok("browser_settings", { action: "record_start" });
    const twice = await agent.failure("browser_settings", { action: "record_start" });
    expect(twice.code).toBe("recording_active");
    expect(twice.hint).toMatch(/record_stop/);
    await agent.ok("browser_settings", stop);
  });

  it("points at answering the dialog while a dialog holds the tab", async () => {
    const f = await fixture();
    await f.navigate();
    const agent = agentMcp(toolPort(f.service));
    await f.evaluate("setTimeout(() => alert('Unsaved changes'), 0); 0");
    await vi.waitFor(() =>
      expect(f.service.state("thread").tabs?.some((tab) => tab.pending_dialog)).toBe(true),
    );
    const held = z
      .object({ pending_dialog: z.object({ dialogId: z.string() }), hint: z.string() })
      .parse(agent.json(await agent.ok("browser_snapshot")));
    expect(held.hint).toMatch(/action:"dialog"/);
    await agent.ok("browser_act", {
      action: "dialog",
      dialogId: held.pending_dialog.dialogId,
      accept: true,
    });
    await agent.ok("browser_snapshot");
  });

  it("explains a read-only script that tried to change the page", async () => {
    const f = await fixture();
    await f.navigate();
    const agent = agentMcp(toolPort(f.service));
    const failure = await agent.failure("browser_evaluate", {
      expression: "document.title = 'changed'",
      mode: "read-only",
    });
    expect(failure.code).toBe("evaluate_failed");
    expect(failure.hint).toMatch(/unrestricted/);
  });

  it("a read-only script reads the site's storage, and is still refused when it writes it", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate(
      "localStorage.setItem('draft', 'kept'); sessionStorage.setItem('tab', 'one'); 0",
    );
    const agent = agentMcp(toolPort(f.service));
    const read = async (expression: string) =>
      agent.json(await agent.ok("browser_evaluate", { expression, mode: "read-only" }));
    expect(await read("localStorage.getItem('draft')")).toBe("kept");
    expect(await read("JSON.stringify([localStorage.getItem('missing')])")).toBe("[null]");
    expect(await read("[localStorage.key(0), sessionStorage.getItem('tab')]")).toEqual([
      "draft",
      "one",
    ]);
    const write = await agent.failure("browser_evaluate", {
      expression: "localStorage.setItem('draft', 'lost')",
      mode: "read-only",
    });
    expect(write.code).toBe("evaluate_failed");
    expect(await f.evaluate("localStorage.getItem('draft')")).toBe("kept");
    // The page's own storage methods stay the browser's.
    expect(await f.evaluate("String(Storage.prototype.getItem).includes('[native code]')")).toBe(
      true,
    );
  });

  it("downscales a screenshot too dense for the model's budget instead of failing", async () => {
    const f = await fixture();
    await f.navigate();
    const agent = agentMcp(toolPort(f.service));
    await agent.ok("browser_settings", { action: "resize", width: 1536, height: 1536 });
    // Random noise barely compresses: at full size this JPEG is far over 768 KB.
    await f.evaluate(
      "(() => { const c = document.createElement('canvas'); c.width = innerWidth; c.height = innerHeight; c.style.cssText = 'position:fixed;inset:0'; const x = c.getContext('2d'); const d = x.createImageData(c.width, c.height); for (let i = 0; i < d.data.length; i += 65536) crypto.getRandomValues(d.data.subarray(i, i + 65536)); for (let i = 3; i < d.data.length; i += 4) d.data[i] = 255; x.putImageData(d, 0, 0); document.body.append(c); return 0; })()",
    );
    const result = await agent.ok("browser_screenshot");
    const image = result.content.find((item) => item.type === "image");
    expect(image?.type === "image" && image.mimeType).toBe("image/jpeg");
  });

  it("asks for less when an upload is over the size limit, without device wording", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate("document.body.innerHTML = '<input type=file aria-label=Attachment>'; 0");
    const dir = await mkdtemp(join(tmpdir(), "ace-upload-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "huge.bin");
    const handle = await open(file, "w");
    await handle.truncate(65 * 1024 * 1024);
    await handle.close();
    const mcp = agentMcp(toolPort(f.service));
    const input = refNamed(mcp.raw(await mcp.ok("browser_snapshot")), "Attachment");
    const failure = await mcp.failure("browser_act", {
      action: "upload",
      ref: input,
      files: [file],
    });
    expect(failure.code).toBe("limit");
    expect(`${failure.message} ${failure.hint}`).not.toMatch(/device/i);
    expect(failure.hint).toMatch(/smaller files/);
  });

  it("asks the person rather than retrying when the host refuses a site", async () => {
    const f = await fixture({ originPolicy: () => false });
    const failure = await agentMcp(toolPort(f.service)).failure("browser_open", {
      url: "https://example.invalid/",
    });
    expect(failure.code).toBe("approval_required");
    expect(failure.hint).toMatch(/ask the person/);
  });
});

describe("browser startup failures", () => {
  it("reports a browser that cannot start as unavailable, not as a generic failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "ace-browser-missing-"));
    const service = new BrowserService({ dataDir: home, executablePath: join(home, "no-chrome") });
    onTestFinished(async () => {
      await service.close();
      await rm(home, { recursive: true, force: true });
    });
    const failure = await agentMcp(toolPort(service)).failure("browser_snapshot");
    expect(failure.code).toBe("browser_unavailable");
  });
});
