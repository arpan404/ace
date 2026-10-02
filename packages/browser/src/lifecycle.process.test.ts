import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
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
      "session limit",
    );
    expect(f.service.state("thread").url).toBe(`${f.url}/`);
    expect(await f.evaluate("document.querySelector('input').getAttribute('aria-label')")).toBe(
      "Name",
    );
  }, 60_000);
  it("releases browser processes and ephemeral profiles on close", async () => {
    const f = await fixture();
    await f.navigate();
    const before = (await exec("ps", ["-axo", "pid,command"])).stdout;
    expect(before).toContain(`--user-data-dir=${f.home}`);
    await f.service.closeThread("thread");
    const after = (await exec("ps", ["-axo", "pid,command"])).stdout;
    expect(after).not.toContain(`--user-data-dir=${f.home}`);
    expect(
      (await readdir(`${f.home}/browser`)).filter((name) => name.startsWith("ephemeral-")),
    ).toEqual([]);
  }, 60_000);

  it("keeps persistent workspace storage and prevents two threads from sharing its live profile", async () => {
    const f = await fixture();
    await f.service.closeThread("thread");
    await f.service.open({ threadId: "thread", workspaceId: "workspace", profile: "persistent" });
    await f.navigate();
    await f.evaluate("localStorage.setItem('retained','yes')");
    await expect(
      f.service.open({ threadId: "second", workspaceId: "workspace", profile: "persistent" }),
    ).rejects.toThrow("already in use");
    await f.service.closeThread("thread");
    await f.service.open({ threadId: "thread", workspaceId: "workspace", profile: "persistent" });
    await f.navigate();
    expect(await f.evaluate("localStorage.getItem('retained')")).toBe("yes");
    // This exercises three real process lifetimes, including graceful shutdown.
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
