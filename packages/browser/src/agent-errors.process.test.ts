import { createServer } from "node:http";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { agentMcp } from "./agent-mcp-test-support.ts";
import { chromeProcesses } from "./chrome-test-process.ts";
import { BrowserService } from "./index.ts";
import { executablePath, fixture, ref } from "./test-support.ts";

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
    const agent = agentMcp(f.service);
    const failure = await agent.failure("navigate", {
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
    const agent = agentMcp(f.service);
    await agent.ok("navigate", { url: `${f.url}/?before` });
    const name = ref(agent.text(await agent.ok("snapshot")), "Name");
    const { browser } = await chromeProcesses(f.home);
    if (!browser) throw new Error("Browser process missing");
    process.kill(browser, "SIGKILL");
    await vi.waitFor(async () => expect(await f.evaluate("location.search")).toBe("?before"), {
      timeout: 30_000,
      interval: 200,
    });
    const failure = await agent.failure("type", { ref: name, text: "lost" });
    expect(failure.code).toBe("browser_restarted");
    expect(failure.hint).toMatch(/fresh snapshot/);
    // A fresh snapshot is the way back.
    const fresh = ref(agent.text(await agent.ok("snapshot")), "Name");
    await agent.ok("type", { ref: fresh, text: "after restart" });
  }, 60_000);

  it("explains a recording that was never started or is already running", async () => {
    const f = await fixture();
    await f.navigate();
    const agent = agentMcp(f.service);
    expect((await agent.failure("record_stop")).code).toBe("recording_inactive");
    await agent.ok("record_start");
    const twice = await agent.failure("record_start");
    expect(twice.code).toBe("recording_active");
    expect(twice.hint).toMatch(/ace_browser_record_stop/);
    await agent.ok("record_stop");
  });

  it("points at ace_browser_dialog while a dialog holds the tab", async () => {
    const f = await fixture();
    await f.navigate();
    const agent = agentMcp(f.service);
    await f.evaluate("setTimeout(() => alert('Unsaved changes'), 0); 0");
    await vi.waitFor(() =>
      expect(f.service.state("thread").tabs?.some((tab) => tab.pending_dialog)).toBe(true),
    );
    const held = z
      .object({ pending_dialog: z.object({ dialogId: z.string() }), hint: z.string() })
      .parse(agent.text(await agent.ok("snapshot")));
    expect(held.hint).toMatch(/ace_browser_dialog/);
    await agent.ok("dialog", { dialogId: held.pending_dialog.dialogId, accept: true });
    await agent.ok("snapshot");
  });

  it("explains a read-only script that tried to change the page", async () => {
    const f = await fixture();
    await f.navigate();
    const agent = agentMcp(f.service);
    const failure = await agent.failure("evaluate", {
      expression: "document.title = 'changed'",
      mode: "read-only",
    });
    expect(failure.code).toBe("evaluate_failed");
    expect(failure.hint).toMatch(/unrestricted/);
  });

  it("downscales a screenshot too dense for the model's budget instead of failing", async () => {
    const f = await fixture();
    await f.navigate();
    const agent = agentMcp(f.service);
    await agent.ok("resize", { width: 1536, height: 1536 });
    // Random noise barely compresses: at full size this JPEG is far over 768 KB.
    await f.evaluate(
      "(() => { const c = document.createElement('canvas'); c.width = innerWidth; c.height = innerHeight; c.style.cssText = 'position:fixed;inset:0'; const x = c.getContext('2d'); const d = x.createImageData(c.width, c.height); for (let i = 0; i < d.data.length; i += 65536) crypto.getRandomValues(d.data.subarray(i, i + 65536)); for (let i = 3; i < d.data.length; i += 4) d.data[i] = 255; x.putImageData(d, 0, 0); document.body.append(c); return 0; })()",
    );
    const result = await agent.ok("screenshot");
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
    const mcp = agentMcp(f.service);
    const input = ref(mcp.text(await mcp.ok("snapshot")), "Attachment");
    const failure = await mcp.failure("upload", { ref: input, files: [file] });
    expect(failure.code).toBe("limit");
    expect(`${failure.message} ${failure.hint}`).not.toMatch(/device/i);
    expect(failure.hint).toMatch(/smaller files/);
  });

  it("asks the person rather than retrying when the host refuses a site", async () => {
    const f = await fixture({ originPolicy: () => false });
    const failure = await agentMcp(f.service).failure("navigate", {
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
    const opened: Pick<BrowserService, "execute" | "screenshot"> = {
      execute: async (...call) => {
        await service.open({ threadId: "thread", workspaceId: "workspace", background: true });
        return service.execute(...call);
      },
      screenshot: (...call) => service.screenshot(...call),
    };
    const failure = await agentMcp(opened).failure("snapshot");
    expect(failure.code).toBe("browser_unavailable");
  });
});
