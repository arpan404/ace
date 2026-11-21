/*
 * A browser recording end to end (X1): ace's real Chrome, and the real ace-media recording the
 * tab's screencast pictures through its own encode with nobody watching. What the fake recorder
 * in the unit tests can't show: that MP4 parts come out of it, and that a recording refuses,
 * saying why, when ace-media can't run. Needs Chrome and ACE_MEDIA_TEST_BINARY (`bun run
 * check:media` builds and sets it).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MediaRuntime } from "@ace/media/runtime";
import { nodeMediaHost, systemMediaClock } from "@ace/media/supervisor";
import type { BrowserArtifact } from "@ace/protocol";
import { executablePath, fixture } from "./test-support.ts";

const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function runtime(path: string) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "acem-"));
  let next = 0;
  const media = new MediaRuntime({
    version: binary ? execFileSync(binary, ["--version"]).toString().trim() : "0.0.0",
    binary: path,
    runtimeDir,
    dataDir: runtimeDir,
    host: nodeMediaHost(process.env),
    clock: systemMediaClock,
    random: Math.random,
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    id: () => `r${++next}`,
    log: () => {},
  });
  cleanups.push(() => {
    media.dispose();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  return media;
}

/** The video samples an MP4 part holds, from its moof/trun boxes (ISO/IEC 14496-12). */
function samples(path: string): number {
  const file = readFileSync(path);
  expect(file.toString("latin1", 4, 8)).toBe("ftyp");
  let count = 0;
  for (let at = 0; at + 8 <= file.length;) {
    const size = file.readUInt32BE(at);
    if (size < 8) break;
    if (file.toString("latin1", at + 4, at + 8) === "moof") {
      const trun = file.indexOf("trun", at, "latin1");
      if (trun > 0 && trun < at + size) count += file.readUInt32BE(trun + 8);
    }
    at += size;
  }
  return count;
}

describe.skipIf(!executablePath)("browser recordings through ace-media", () => {
  it.runIf(binary)(
    "a public tab's recording comes out as MP4 parts, with nobody watching",
    async () => {
      const media = runtime(binary ?? "");
      const artifacts: BrowserArtifact[] = [];
      const f = await fixture({
        recorder: media.recordings,
        onArtifact: (_, artifact) => void artifacts.push(artifact),
      });
      await f.navigate();
      await f.service.startRecording("thread");
      // The page changes while it records, so the screencast has pictures to give.
      for (let step = 0; step < 20; step++) {
        await f.evaluate(`document.body.style.background = 'hsl(${step * 18}, 80%, 50%)'`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const artifact = await f.service.stopRecording("thread");
      expect(artifact).toMatchObject({
        mimeType: "video/mp4",
        path: expect.stringMatching(/\.mp4$/),
      });
      expect(artifacts).toContainEqual(artifact);
      expect(samples(artifact.path)).toBeGreaterThan(0);
    },
    90_000,
  );

  it("refuses to record, saying why, while ace-media can't start", async () => {
    const media = runtime("/nonexistent/ace-media");
    const f = await fixture({ recorder: media.recordings });
    await f.navigate();
    await expect(f.service.startRecording("thread")).rejects.toMatchObject({
      code: "recording_failed",
      detail: expect.stringContaining("ace-media isn't available to record"),
    });
    expect(f.service.state("thread").recording).toBeUndefined();
  }, 60_000);
});
