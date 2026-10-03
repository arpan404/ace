import { execFile, spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { executablePath, fixture } from "./test-support.ts";

const noop = () => {};
const exec = promisify(execFile);
let releaseDelayedStop = noop;
afterEach(() => {
  releaseDelayedStop();
  releaseDelayedStop = noop;
});

describe.skipIf(!executablePath)("injected browser process boundaries", () => {
  it("uses an injected launcher with real Chromium", async () => {
    const f = await fixture({
      launchContext: (profile, options) =>
        chromium.launchPersistentContext(profile, {
          ...options,
          viewport: { width: 640, height: 480 },
        }),
    });
    expect(await f.evaluate("[innerWidth,innerHeight]")).toEqual([640, 480]);
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

  it("waits for the first Chromium shutdown before releasing its writable profile", async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let fence: (() => Promise<unknown>) | undefined;
    let closing = false;
    const f = await fixture({
      launchContext: async (profile, options) => {
        const context = await chromium.launchPersistentContext(profile, options);
        const page = context.pages()[0];
        if (!page) throw new Error("Missing page");
        const cdp = await context.newCDPSession(page);
        fence = async () => {
          await cdp.send("Memory.getDOMCounters").catch(() => {});
          return readdir(join(profile, ".."));
        };
        const close = context.close.bind(context);
        // At the I/O boundary, a repeated close can return before the original finishes.
        context.close = async () => {
          if (closing) return;
          closing = true;
          await close();
          entered.resolve();
          await release.promise;
        };
        releaseDelayedStop = release.resolve;
        return context;
      },
    });
    const finished = Promise.withResolvers<void>();
    const stopping = f.service.closeThread("thread").then(
      () => finished.resolve(),
      (error: unknown) => {
        finished.resolve();
        throw error;
      },
    );
    const result = Promise.allSettled([stopping]);
    try {
      await entered.promise;
      if (!fence) throw new Error("Missing CDP barrier");
      expect(
        await Promise.race([
          finished.promise.then(() => "closed before first shutdown completed"),
          fence().then(() => "first shutdown still pending"),
        ]),
      ).toBe("first shutdown still pending");
      expect(
        (await readdir(join(f.home, "browser"))).some((name) => name.startsWith("ephemeral-")),
      ).toBe(true);
    } finally {
      release.resolve();
      const outcomes = await result;
      expect(outcomes[0]?.status).toBe("fulfilled");
    }
    expect(
      (await readdir(join(f.home, "browser"))).filter((name) => name.startsWith("ephemeral-")),
    ).toEqual([]);
  });

  it("closes Chromium even when a screencast stop response is delayed until transport closure", async () => {
    const closed = Promise.withResolvers<void>();
    const f = await fixture({
      launchContext: async (profile, options) => {
        const context = await chromium.launchPersistentContext(profile, options);
        context.once("close", () => closed.resolve());
        releaseDelayedStop = closed.resolve;
        const createSession = context.newCDPSession.bind(context);
        context.newCDPSession = async (page) => {
          const session = await createSession(page);
          const send = session.send.bind(session);
          session.send = async (method, params) => {
            const result = await send(method, params);
            if (method === "Page.stopScreencast") await closed.promise;
            return result;
          };
          return session;
        };
        return context;
      },
    });
    await f.service.closeThread("thread");
    await closed.promise;
    expect(
      (await readdir(`${f.home}/browser`)).filter((name) => name.startsWith("ephemeral-")),
    ).toEqual([]);
    expect(() => f.service.state("thread")).toThrow("not open");
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
