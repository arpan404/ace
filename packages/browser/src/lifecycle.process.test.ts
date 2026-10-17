import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executablePath, fixture } from "./test-support.ts";
import type { BrowserArtifact } from "@ace/protocol";

const exec = promisify(execFile);
describe.skipIf(!executablePath)("browser lifecycle and recordings", () => {
  it("closes while an approval hook is still waiting and rejects that pending operation", async () => {
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
    expect((await exec("ps", ["-axo", "command"])).stdout).not.toContain(
      `--user-data-dir=${f.home}`,
    );
  }, 60_000);

  it("limits active sessions without replacing the running browser", async () => {
    const f = await fixture({ maxSessions: 1 });
    await f.navigate();
    await expect(f.service.open({ threadId: "second", workspaceId: "other" })).rejects.toThrow(
      "All browser pages are in use",
    );
    expect(f.service.state("thread").url).toBe(`${f.url}/`);
    expect(await f.evaluate("document.querySelector('input').getAttribute('aria-label')")).toBe(
      "Name",
    );
  }, 60_000);
  it("ace's browser exits once its last thread closes and the idle period passes", async () => {
    const f = await fixture({ chrome: { idleMs: 0 } });
    await f.navigate();
    expect((await exec("ps", ["-axo", "pid,command"])).stdout).toContain(
      `--user-data-dir=${f.home}`,
    );
    await f.service.closeThread("thread");
    await vi.waitFor(
      async () =>
        expect((await exec("ps", ["-axo", "pid,command"])).stdout).not.toContain(
          `--user-data-dir=${f.home}`,
        ),
      { timeout: 30_000, interval: 100 },
    );
  }, 60_000);

  it("persistent threads share ace's profile across browser restarts, private threads do not", async () => {
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
    await vi.waitFor(
      async () =>
        expect((await exec("ps", ["-axo", "pid,command"])).stdout).not.toContain(
          `--user-data-dir=${f.home}`,
        ),
      { timeout: 30_000, interval: 100 },
    );
    await f.service.open({ threadId: "thread", workspaceId: "workspace" });
    await f.navigate();
    expect(await f.evaluate("localStorage.getItem('retained')")).toBe("yes");
    // This exercises two real browser lifetimes, including graceful shutdown.
  }, 120_000);

  it("saves a timestamped frame manifest and a player and reports the recording artifact", async () => {
    const artifacts: BrowserArtifact[] = [];
    const f = await fixture({
      ffmpeg: "/nonexistent/ffmpeg",
      onArtifact: (_, artifact) => {
        artifacts.push(artifact);
      },
    });
    await f.navigate();
    await f.service.startRecording("thread");
    const artifact = await f.service.stopRecording("thread");
    expect(artifact.mimeType).toBe("text/html");
    expect(await readFile(artifact.path, "utf8")).toContain("frames.jsonl");
    const dir = artifact.path.replace(/\/player\.html$/, "");
    const manifest = (await readFile(`${dir}/frames.jsonl`, "utf8"))
      .trim()
      .split("\n")
      .map((line) => z.object({ file: z.string(), timestamp: z.number() }).parse(JSON.parse(line)));
    expect(manifest.length).toBeGreaterThan(0);
    const first = manifest[0];
    if (!first) throw new Error("Empty manifest");
    expect((await readFile(`${dir}/${first.file}`)).subarray(0, 2)).toEqual(
      Buffer.from([255, 216]),
    );
    expect(artifacts).toEqual([artifact]);
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  it("encodes playable MP4 with ffmpeg when available", async (context) => {
    try {
      await exec("ffmpeg", ["-version"]);
    } catch {
      context.skip("ffmpeg unavailable");
      return;
    }
    const f = await fixture({ ffmpeg: "ffmpeg" });
    await f.navigate();
    await f.service.startRecording("thread");
    const artifact = await f.service.stopRecording("thread");
    expect(artifact.mimeType).toBe("video/mp4");
    const result = await exec("ffmpeg", ["-v", "error", "-i", artifact.path, "-f", "null", "-"]);
    expect(result.stderr).toBe("");
    expect(artifact.bytes).toBeGreaterThan(0);
  }, 60_000);
});
