import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { executablePath, fixture } from "./test-support.ts";
import { installChromium } from "./index.ts";

const noop = () => {};
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
  }, 30_000);

  it("falls back to a playable sequence when an injected encoder process fails", async () => {
    const f = await fixture({
      ffmpeg: "ffmpeg",
      spawn: (_command, _args, options) =>
        spawn(process.execPath, ["-e", "process.exit(1)"], options),
    });
    await f.navigate();
    await f.service.startRecording("thread");
    const artifact = await f.service.stopRecording("thread");
    expect(artifact.mimeType).toBe("text/html");
    const dir = artifact.path.replace(/\/player\.html$/, "");
    expect(await readFile(`${dir}/frames.jsonl`, "utf8")).toContain('"file":"1.jpg"');
    expect((await readFile(`${dir}/1.jpg`)).subarray(0, 2)).toEqual(Buffer.from([255, 216]));
  }, 30_000);

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
  }, 30_000);

  it("uses injected installer and cache lookup processes", async () => {
    const f = await fixture();
    const path = await installChromium(f.home, (_command, _args, options) =>
      spawn(process.execPath, ["-e", "process.stdout.write(process.execPath)"], {
        ...options,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    expect(path).toBe(process.execPath);
  }, 30_000);
});
