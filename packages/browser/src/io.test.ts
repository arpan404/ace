import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { executablePath, fixture } from "./test-support.ts";
import { installChromium } from "./index.ts";

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
