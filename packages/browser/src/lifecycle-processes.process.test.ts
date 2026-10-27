import { execFile, spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BrowserArtifact } from "@ace/protocol";
import { chromeProcesses } from "./chrome-test-process.ts";
import { executablePath, fixture } from "./test-support.ts";

/*
 * ace's Chrome lifecycle as Windows sees it: processes come from CIM rather than `ps`, listeners
 * from `netstat`, and artifact paths use backslashes.
 */

const exec = promisify(execFile);
const gone = async (home: string) =>
  vi.waitFor(async () => expect((await chromeProcesses(home)).browser).toBeUndefined(), {
    timeout: 30_000,
    interval: 250,
  });

describe.runIf(process.platform === "win32" && executablePath)("Windows browser lifecycle", () => {
  it("Windows: closing while an approval hook waits rejects that operation and leaves no Chrome running", async () => {
    const { promise: entered, resolve: notify } = Promise.withResolvers<void>();
    const { promise: gate } = Promise.withResolvers<boolean>();
    const f = await fixture({
      evaluatePolicy: () => {
        notify();
        return gate;
      },
    });
    await f.navigate();
    const rejected = expect(f.evaluate("1")).rejects.toThrow("shutting down");
    await entered;
    await f.service.close();
    await rejected;
    await gone(f.home);
  }, 60_000);

  it("Windows: ace's browser exits once its last thread closes and the idle period passes", async () => {
    const f = await fixture({ chrome: { idleMs: 0 } });
    await f.navigate();
    expect((await chromeProcesses(f.home)).browser).toBeDefined();
    await f.service.closeThread("thread");
    await gone(f.home);
  }, 60_000);

  it("Windows: persistent threads share ace's profile across browser restarts, private threads do not", async () => {
    const f = await fixture({ chrome: { idleMs: 0 } });
    await f.navigate();
    await f.evaluate("localStorage.setItem('retained','yes')");
    await f.service.open({ threadId: "second", workspaceId: "other", profile: "persistent" });
    await f.service.execute("second", { action: "navigate", url: f.url });
    const read = { action: "evaluate", expression: "localStorage.getItem('retained')" };
    expect(await f.service.execute("second", read)).toBe("yes");
    await f.service.open({ threadId: "private", workspaceId: "workspace", profile: "ephemeral" });
    await f.service.execute("private", { action: "navigate", url: f.url });
    expect(await f.service.execute("private", read)).toBe(null);
    for (const thread of ["thread", "second", "private"]) await f.service.closeThread(thread);
    await gone(f.home);
    // The profile lock is released with the old browser: a new one opens the same profile.
    await f.service.open({ threadId: "thread", workspaceId: "workspace" });
    await f.navigate();
    expect(await f.evaluate("localStorage.getItem('retained')")).toBe("yes");
  }, 120_000);

  it("Windows: a recording saves a timestamped frame manifest beside a player that plays, and reports the artifact", async () => {
    const artifacts: BrowserArtifact[] = [];
    const f = await fixture({
      ffmpeg: "C:\\nonexistent\\ffmpeg.exe",
      onArtifact: (_, artifact) => {
        artifacts.push(artifact);
      },
    });
    await f.navigate();
    await f.service.startRecording("thread");
    const artifact = await f.service.stopRecording("thread");
    expect(artifact.mimeType).toBe("text/html");
    expect(artifact.path).toMatch(/\\player\.html$/);
    const dir = dirname(artifact.path);
    const manifest = (await readFile(join(dir, "frames.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => z.object({ file: z.string(), timestamp: z.number() }).parse(JSON.parse(line)));
    const first = manifest[0];
    if (!first) throw new Error("Empty manifest");
    expect((await readFile(join(dir, first.file))).subarray(0, 2)).toEqual(Buffer.from([255, 216]));
    expect(artifacts).toEqual([artifact]);
    // The player plays its frames when served as a page.
    const server = createServer((request, response) => {
      const name = basename(new URL(request.url ?? "/", "http://localhost").pathname);
      createReadStream(join(dir, name))
        .on("error", () => {
          response.statusCode = 404;
          response.end();
        })
        .pipe(response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No player address");
      await f.execute({ action: "navigate", url: `http://127.0.0.1:${address.port}/player.html` });
      expect(
        await f.evaluate(
          `new Promise(resolve=>{const image=document.getElementById('frame');image.onload=()=>resolve(image.naturalWidth);document.getElementById('play').click()})`,
        ),
      ).toBeGreaterThan(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  it("Windows: a recording whose encoder process fails falls back to a playable frame sequence", async () => {
    let failurePath = "";
    const f = await fixture({
      ffmpeg: "ffmpeg",
      spawn: (_command, _args, options) =>
        spawn(
          process.execPath,
          [
            "-e",
            "require('node:fs').writeFileSync(process.argv[1],'encoder rejected input');process.exit(1)",
            failurePath,
          ],
          options,
        ),
    });
    failurePath = join(f.home, "encoder-failure.txt");
    await f.navigate();
    await f.service.startRecording("thread");
    const artifact = await f.service.stopRecording("thread");
    expect(await readFile(failurePath, "utf8")).toBe("encoder rejected input");
    expect(artifact.mimeType).toBe("text/html");
    const dir = dirname(artifact.path);
    expect(await readFile(join(dir, "frames.jsonl"), "utf8")).toContain('"file":"1.jpg"');
    expect((await readFile(join(dir, "1.jpg"))).subarray(0, 2)).toEqual(Buffer.from([255, 216]));
  }, 60_000);

  it("Windows: a thread closes even when the screencast stop is never answered, and Chrome goes", async () => {
    const f = await fixture({
      chrome: {
        intercept: {
          send: (send) => (method, params, sessionId) =>
            method === "Page.stopScreencast"
              ? new Promise(() => {})
              : send(method, params, sessionId),
        },
      },
    });
    await f.service.closeThread("thread");
    expect(() => f.service.state("thread")).toThrow("not open");
    await f.service.close();
    await gone(f.home);
  }, 60_000);

  it("Windows: ace's Chrome talks over its pipe and listens on no TCP port", async () => {
    const f = await fixture();
    await f.navigate();
    const { browser, commandLine } = await chromeProcesses(f.home);
    expect(commandLine).toContain("--remote-debugging-pipe");
    expect(commandLine).not.toContain("--remote-debugging-port");
    expect(existsSync(join(f.home, "browser", "profile", "DevToolsActivePort"))).toBe(false);
    const { stdout } = await exec("netstat", ["-a", "-n", "-o", "-p", "TCP"], {
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    // `TCP  127.0.0.1:9222  0.0.0.0:0  LISTENING  <pid>`
    const listening = stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((row) => row[3] === "LISTENING" && row[4] === String(browser));
    expect(browser).toBeDefined();
    expect(listening).toEqual([]);
  }, 60_000);
});
