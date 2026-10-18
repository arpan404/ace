import { execFile, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { CdpSend } from "./cdp-connection.ts";
import { executablePath, fixture } from "./test-support.ts";

const exec = promisify(execFile);

describe.skipIf(!executablePath)("injected browser process boundaries", () => {
  it("passes an embedder's extra launch flags to ace's Chrome", async () => {
    const f = await fixture({ chrome: { args: ["--user-agent=ace-injected-agent"] } });
    expect(await f.evaluate("navigator.userAgent")).toBe("ace-injected-agent");
  }, 60_000);

  it("falls back to a playable sequence when an injected encoder process fails", async () => {
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
    const dir = artifact.path.replace(/\/player\.html$/, "");
    expect(await readFile(`${dir}/frames.jsonl`, "utf8")).toContain('"file":"1.jpg"');
    expect((await readFile(`${dir}/1.jpg`)).subarray(0, 2)).toEqual(Buffer.from([255, 216]));
  }, 60_000);

  it("closes a thread even when the screencast stop is never answered", async () => {
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
    expect((await exec("ps", ["-axo", "command"])).stdout).not.toContain(
      `--user-data-dir=${f.home}`,
    );
  }, 60_000);

  it("returns the distinct playable video produced by an injected encoder", async (context) => {
    try {
      await exec("ffmpeg", ["-version"], { maxBuffer: 64 * 1024 });
    } catch {
      context.skip("ffmpeg unavailable");
    }
    const f = await fixture({
      // Ignoring the injected process must fail, rather than finding a real encoder.
      ffmpeg: "/ace-test/injected-encoder-only",
      spawn: (command, args, options) => {
        const helper = args[0];
        const raw = args[1];
        if (!helper || !raw) throw new Error("Missing encoder process payload");
        const payload = z.object({ cwd: z.string() }).parse(JSON.parse(raw));
        return spawn(
          command,
          [
            helper,
            JSON.stringify({
              cwd: payload.cwd,
              executable: "ffmpeg",
              args: [
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=red:s=32x32:d=1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "recording.mp4",
              ],
            }),
          ],
          options,
        );
      },
    });
    await f.navigate();
    await f.service.startRecording("thread");
    const artifact = await f.service.stopRecording("thread");
    expect(artifact.mimeType).toBe("video/mp4");
    const decoded = await exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        artifact.path,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 4096 },
    );
    expect(decoded.stdout.length).toBe(32 * 32 * 3);
    expect(decoded.stdout.readUInt8(0)).toBeGreaterThan(200);
    expect(decoded.stdout.readUInt8(1)).toBeLessThan(30);
    expect(decoded.stdout.readUInt8(2)).toBeLessThan(30);
  }, 60_000);
});

it.skipIf(!executablePath)(
  "closing the last Chromium page publishes closed state and permits reopening",
  async () => {
    const pages: string[] = [];
    let wire: CdpSend | undefined;
    const f = await fixture({
      chrome: {
        intercept: {
          send: (send) => {
            wire = send;
            return send;
          },
          event: (method, params, sessionId) => {
            const attached = z
              .object({ targetInfo: z.object({ targetId: z.string(), type: z.literal("page") }) })
              .safeParse(params);
            if (method === "Target.attachedToTarget" && !sessionId && attached.success)
              pages.push(attached.data.targetInfo.targetId);
          },
        },
      },
    });
    const page = pages.at(-1);
    if (!page || !wire) throw new Error("Missing page");
    await wire("Target.closeTarget", { targetId: page });
    await vi.waitFor(() => expect(() => f.service.state("thread")).toThrow("not open"));
    await f.service.open({ threadId: "thread", workspaceId: "workspace" });
    await f.navigate();
    expect(f.service.state("thread").url).toBe(f.url + "/");
  },
);
