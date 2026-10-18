import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import type { CdpSend } from "./cdp-connection.ts";
import { chromeProcesses } from "./chrome-test-process.ts";
import { executablePath, fixture, ref } from "./test-support.ts";

const exec = promisify(execFile);
const Attached = z.object({
  sessionId: z.string(),
  targetInfo: z.object({ type: z.literal("page") }),
});
const Paused = z.object({ request: z.object({ url: z.string() }) });
const Value = z.object({ result: z.object({ value: z.unknown() }) });

/** Records the raw wire: page sessions as they attach and every paused request. */
function wireTap() {
  const pages: string[] = [];
  const paused: string[] = [];
  let send: CdpSend | undefined;
  return {
    pages,
    paused,
    send: (method: string, params: Record<string, unknown>, sessionId: string) => {
      if (!send) throw new Error("Browser not started");
      return send(method, params, sessionId);
    },
    intercept: {
      send: (next: CdpSend) => {
        send = next;
        return next;
      },
      event: (method: string, params: unknown, sessionId: string) => {
        const attached = Attached.safeParse(params);
        if (method === "Target.attachedToTarget" && !sessionId && attached.success)
          pages.push(attached.data.sessionId);
        const request = Paused.safeParse(params);
        if (method === "Fetch.requestPaused" && request.success)
          paused.push(request.data.request.url);
      },
    },
  };
}
async function browserPid(home: string): Promise<number> {
  const { browser } = await chromeProcesses(home);
  if (!browser) throw new Error("Browser process missing");
  return browser;
}

describe.skipIf(!executablePath)("ace's Chrome over a pipe", () => {
  it("listens on no debugging port and writes no DevToolsActivePort", async () => {
    const f = await fixture();
    await f.navigate();
    const { browser, commandLine } = await chromeProcesses(f.home);
    expect(commandLine).toContain("--remote-debugging-pipe");
    expect(commandLine).not.toContain("--remote-debugging-port");
    expect(existsSync(join(f.home, "browser", "profile", "DevToolsActivePort"))).toBe(false);
    const listening = await exec("lsof", [
      "-nP",
      "-a",
      "-p",
      String(browser),
      "-iTCP",
      "-sTCP:LISTEN",
    ]).then(
      (result) => result.stdout,
      // lsof exits 1 when nothing matches.
      (error: unknown) => z.object({ stdout: z.string() }).parse(error).stdout,
    );
    expect(listening.trim()).toBe("");
  }, 60_000);

  it("carries a 1 MiB CDP message each way over the pipe", async () => {
    const tap = wireTap();
    const f = await fixture({ chrome: { intercept: tap.intercept } });
    const page = tap.pages.at(-1);
    if (!page) throw new Error("Page session missing");
    const evaluate = async (expression: string) =>
      Value.parse(await tap.send("Runtime.evaluate", { expression, returnByValue: true }, page))
        .result.value;
    const mebibyte = 1024 * 1024;
    expect(await evaluate(`'${"y".repeat(mebibyte)}'.length`)).toBe(mebibyte);
    const large = await evaluate(`'x'.repeat(${mebibyte})`);
    expect(typeof large === "string" && large.length).toBe(mebibyte);
    expect(await f.evaluate("1 + 1")).toBe(2);
  }, 60_000);

  it("loads a subresource-heavy page while pausing only its document", async () => {
    let served = 0;
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/asset/")) {
        served++;
        response.setHeader("Content-Type", "image/svg+xml");
        response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
        return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<!doctype html><title>Heavy</title>${Array.from(
          { length: 300 },
          (_, index) => `<img src="/asset/${index}.svg" alt="">`,
        ).join("")}`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server address missing");
    const url = `http://127.0.0.1:${address.port}/`;
    const tap = wireTap();
    const f = await fixture({ chrome: { intercept: tap.intercept } });
    await f.execute({ action: "navigate", url });
    expect(
      await f.evaluate(
        "Promise.all([...document.images].map(i => i.decode().then(() => 1, () => 0))).then(r => r.reduce((a, b) => a + b, 0))",
      ),
    ).toBe(300);
    expect(served).toBe(300);
    expect(tap.paused).toEqual([url]);
  }, 60_000);

  it("brings a page back at its last URL after its renderer is killed", async () => {
    const f = await fixture();
    await f.navigate();
    await f.evaluate("window.marker = 'before crash'");
    const { renderers } = await chromeProcesses(f.home);
    expect(renderers.length).toBeGreaterThan(0);
    for (const pid of renderers) process.kill(pid, "SIGKILL");
    await vi.waitFor(
      async () => expect(await f.evaluate("typeof window.marker")).toBe("undefined"),
      {
        timeout: 30_000,
        interval: 200,
      },
    );
    expect(f.service.state("thread")).toMatchObject({ url: `${f.url}/`, closed: false });
    expect(await f.evaluate("document.querySelector('input').getAttribute('aria-label')")).toBe(
      "Name",
    );
  }, 60_000);

  it("restarts a killed browser and reopens the thread's page", async () => {
    const f = await fixture();
    await f.execute({ action: "navigate", url: `${f.url}/?restarted` });
    const first = await browserPid(f.home);
    process.kill(first, "SIGKILL");
    await vi.waitFor(async () => expect(await f.evaluate("location.search")).toBe("?restarted"), {
      timeout: 30_000,
      interval: 200,
    });
    expect(await browserPid(f.home)).not.toBe(first);
    expect(f.service.state("thread")).toMatchObject({ status: "ready", closed: false });
    const snapshot = await f.execute({ action: "snapshot" });
    await f.execute({ action: "type", ref: ref(snapshot, "Name"), text: "after restart" });
    expect(await f.evaluate("document.querySelector('input').value")).toBe("after restart");
  }, 60_000);

  it("fails a command with no reply at its deadline while later commands still run", async () => {
    const f = await fixture({ chrome: { commandTimeoutMs: 1_000 } });
    await f.navigate();
    const pid = await browserPid(f.home);
    await expect(f.evaluate("new Promise(() => {})")).rejects.toThrow();
    expect(await f.evaluate("2 + 2")).toBe(4);
    expect(await browserPid(f.home)).toBe(pid);
  }, 60_000);

  it.skipIf(process.platform === "win32")(
    "replaces a browser that stops answering",
    async () => {
      const f = await fixture({ chrome: { commandTimeoutMs: 1_000 } });
      await f.navigate();
      const wedged = await browserPid(f.home);
      process.kill(-wedged, "SIGSTOP");
      onTestFinished(() => {
        try {
          process.kill(-wedged, "SIGCONT");
        } catch {
          /* Replaced and killed. */
        }
      });
      await expect(f.evaluate("1")).rejects.toThrow();
      await vi.waitFor(async () => expect(await f.evaluate("location.href")).toBe(`${f.url}/`), {
        timeout: 45_000,
        interval: 250,
      });
      expect(() => process.kill(wedged, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    },
    60_000,
  );

  it("types key chords the way a keyboard does", async () => {
    const f = await fixture();
    await f.navigate();
    const name = ref(await f.execute({ action: "snapshot" }), "Name");
    await f.execute({ action: "press", ref: name, key: "Shift+a" });
    await f.execute({ action: "press", ref: name, key: "b" });
    expect(await f.evaluate("document.querySelector('input').value")).toBe("Ab");
    await f.execute({ action: "press", ref: name, key: "ControlOrMeta+a" });
    await f.execute({ action: "press", ref: name, key: "Backspace" });
    expect(await f.evaluate("document.querySelector('input').value")).toBe("");
  }, 60_000);
});
