import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EgressUnit } from "@ace/media/egress";
import { MediaRuntime } from "@ace/media/runtime";
import { nodeMediaHost, systemMediaClock, type MediaSettings } from "@ace/media/supervisor";
import { connectBrowser } from "./index.ts";
import type { BrowserMedia } from "./media-video.ts";
import { decodeStreamMessage, StreamAssembler } from "./stream.ts";
import type { BrowserVideoChunk } from "./stream-video.ts";
import { executablePath, fixture } from "./test-support.ts";

// Live video through the real ace-media (E4): a tab of ace's Chrome streams its WebCodecs chunks
// through the video extension's WebSocket into the binary, and its units come back on egress to
// the viewer; a private-context tab's screencast is encoded by ace-media itself. Real edges a
// unit test can't cover: Chrome's WebSocket from the extension origin, the binary's ingest and
// egress lane, and the route moving producers while they stream. Runs when
// ACE_MEDIA_TEST_BINARY names a built ace-media (`bun run check:media` builds it).
const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function until(condition: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A real MediaRuntime on the binary, and the BrowserMedia the daemon would give the browser. */
function media(settings: MediaSettings) {
  const path = binary ?? "";
  const runtimeDir = mkdtempSync(join(tmpdir(), "acem-"));
  let ids = 0;
  const runtime = new MediaRuntime({
    version: execFileSync(path, ["--version"]).toString().trim(),
    binary: path,
    runtimeDir,
    dataDir: runtimeDir,
    settings: () => settings,
    host: nodeMediaHost(process.env),
    clock: systemMediaClock,
    random: Math.random,
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    id: () => `source-${++ids}`,
    log: () => {},
  });
  const units: EgressUnit[] = [];
  const statuses: unknown[] = [];
  const browser: BrowserMedia = {
    open: (kind, listener, sourceIds) =>
      runtime.sources.open(
        kind,
        { kind },
        {
          ...listener,
          unit: (unit) => {
            units.push(unit);
            listener.unit(unit);
          },
          status: (status) => {
            statuses.push(status);
            listener.status?.(status);
          },
        },
        sourceIds,
      ),
    routed: (kind) => runtime.sources.routed(kind),
    wanted: (kind) => runtime.sources.wanted(kind),
    pictureCodecs: () => runtime.pictureCodecs(),
  };
  cleanups.push(() => {
    runtime.dispose();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  runtime.settingsChanged();
  return { runtime, browser, units, statuses };
}

/** A viewer on this machine that asks for H.264 and acknowledges every chunk at once. */
function viewer(f: Awaited<ReturnType<typeof fixture>>) {
  const chunks: BrowserVideoChunk[] = [];
  const assembler = new StreamAssembler();
  const bridge = connectBrowser(f.service, {
    connectionId: "viewer",
    authorize: () => true,
    send: () => true,
    sendStream: (pieces) => {
      for (const piece of pieces) {
        const envelope = assembler.push(piece);
        const message = envelope && decodeStreamMessage(envelope);
        if (message?.kind !== "browser.video") continue;
        chunks.push(message.chunk);
        void bridge.handle({
          type: "browser.ack",
          threadId: "thread",
          requestId: `ack-${message.chunk.sequence}`,
          sequence: message.chunk.sequence,
          video: true,
        });
      }
      return true;
    },
  });
  return {
    chunks,
    subscribe: () =>
      bridge.handle({
        type: "browser.subscribe",
        threadId: "thread",
        requestId: "subscribe",
        binaryFrames: true,
        viewport: { width: 640, height: 400, devicePixelRatio: 1 },
        video: { codecs: ["avc1.42E033"] },
      }),
  };
}

/** Decodes the chunks of one encode in the page with WebCodecs, from their first keyframe. */
async function decode(f: Awaited<ReturnType<typeof fixture>>, all: readonly BrowserVideoChunk[]) {
  const start = all.findIndex((chunk) => chunk.key);
  const chunks = all.slice(start);
  const first = chunks[0];
  if (!first) throw new Error("No keyframe");
  const input = chunks.map((chunk) => ({
    key: chunk.key,
    data: Buffer.from(chunk.bytes).toString("base64"),
    sequence: chunk.sequence,
  }));
  const config = {
    codec: first.codec,
    codedWidth: first.codedWidth,
    codedHeight: first.codedHeight,
    ...(first.description
      ? { description: Buffer.from(first.description).toString("base64") }
      : {}),
  };
  // Evaluated expressions are bounded, so the chunks go over in batches.
  await f.evaluate("window.chunks = []");
  let batch: typeof input = [];
  let size = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await f.evaluate(`window.chunks.push(...${JSON.stringify(batch)})`);
    batch = [];
    size = 0;
  };
  for (const chunk of input) {
    if (size + chunk.data.length > 48_000) await flush();
    batch.push(chunk);
    size += chunk.data.length + 64;
  }
  await flush();
  const result = await f.evaluate(`(async () => {
    const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const config = ${JSON.stringify(config)};
    let pictures = 0;
    const errors = [];
    const decoder = new VideoDecoder({
      output: (frame) => { pictures++; frame.close(); },
      error: (error) => errors.push(String(error)),
    });
    decoder.configure({ ...config, ...(config.description ? { description: bytes(config.description) } : {}) });
    for (const chunk of window.chunks)
      decoder.decode(new EncodedVideoChunk({ type: chunk.key ? "key" : "delta", timestamp: chunk.sequence, data: bytes(chunk.data) }));
    await decoder.flush().catch((error) => errors.push(String(error)));
    return JSON.stringify({ pictures, errors });
  })()`);
  const decoded = JSON.parse(String(result)) as { pictures: number; errors: string[] };
  return { ...decoded, chunks: chunks.length };
}

const animate =
  "window.animating=true; window.counter=0; (function animate(){ if(!window.animating)return; document.body.style.background=`rgb(${++window.counter%255},40,90)`; document.getElementById('result').textContent=String(window.counter); requestAnimationFrame(animate)})()";

/** No chunk reached the viewer twice: the same bytes never arrive back to back. */
function noRepeats(chunks: readonly BrowserVideoChunk[]): boolean {
  return chunks.every(
    (chunk, i) =>
      i === 0 || !Buffer.from(chunk.bytes).equals(Buffer.from(chunks[i - 1]?.bytes ?? [])),
  );
}

describe.runIf(binary && executablePath)("live video through ace-media", () => {
  it("a tab streams through the video extension into ace-media and back out on egress, survives route flips, and falls back to the daemon when ace-media is killed", async () => {
    const settings: MediaSettings = {
      encode: "auto",
      delivery: "legacy",
      recordings: "legacy",
      stills: "legacy",
    };
    const m = media(settings);
    const f = await fixture({ media: m.browser });
    await f.navigate();
    await f.service.execute("thread", { action: "resize", width: 640, height: 400 });
    const v = viewer(f);
    await v.subscribe();
    await f.evaluate(animate);

    // Chunks come back from ace-media's egress, binary end to end.
    await until(() => m.units.length >= 30, "units on egress");
    expect(m.runtime.routes.routes().tab.producer).toBe("ace-media");
    const unit = m.units.find((u) => (u.frame.flags & 1) !== 0);
    expect(unit?.frame).toMatchObject({ kind: 1, codec: 2 });
    expect(unit?.frame.codecString.startsWith("avc1.")).toBe(true);
    await until(() => v.chunks.length >= 30, "the viewer's video");

    // Back to the daemon's path, and to ace-media again, while the tab streams.
    settings.encode = "legacy";
    m.runtime.settingsChanged();
    expect(m.runtime.routes.routes().tab.producer).toBe("daemon");
    const viaMedia = m.units.length;
    const atLegacy = v.chunks.length;
    await until(() => v.chunks.length >= atLegacy + 60, "video on the daemon's path");
    const lateUnits = m.units.length - viaMedia;
    settings.encode = "auto";
    m.runtime.settingsChanged();
    const atAuto = m.units.length;
    await until(() => m.units.length >= atAuto + 60, "units on egress again");
    // Units in flight at the flip still arrived (a handful at most), and nothing was dropped.
    expect(lateUnits).toBeLessThan(30);
    expect(m.runtime.egress.drops()).toEqual({
      invalid: 0,
      unknown: 0,
      closed: 0,
      gaps: 0,
      unrouted: 0,
    });
    expect(noRepeats(v.chunks)).toBe(true);
    const decoded = await decode(f, v.chunks);
    expect(decoded.errors).toEqual([]);
    expect(decoded.pictures).toBe(decoded.chunks);

    // ace-media killed: the tab streams to the daemon again within 2 s.
    const pid = m.runtime.supervisor.snapshot().pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    const atKill = v.chunks.length;
    const killed = performance.now();
    process.kill(pid, "SIGKILL");
    await until(() => m.runtime.routes.routes().tab.producer === "daemon", "the route back");
    await until(() => v.chunks.length >= atKill + 30, "video after the kill", 5_000);
    expect(performance.now() - killed).toBeLessThan(5_000);
    const after = v.chunks.slice(atKill);
    expect(after.some((chunk) => chunk.key)).toBe(true);
  }, 90_000);

  it.runIf(process.platform === "darwin")(
    "a private-context tab's screencast is encoded by ace-media on VideoToolbox once it is up, and the viewer plays its units",
    async () => {
      const settings: MediaSettings = {
        encode: "auto",
        delivery: "legacy",
        recordings: "legacy",
        stills: "legacy",
      };
      const m = media(settings);
      const f = await fixture({ media: m.browser, profilePreference: () => "ephemeral" });
      await f.navigate();
      await f.service.execute("thread", { action: "resize", width: 640, height: 400 });
      const v = viewer(f);
      await v.subscribe();
      await f.evaluate(animate);
      await until(() => m.units.length >= 20, "units from ace-media's encoder", 30_000);
      // The capture the browser's encoder started with hands over: the viewer now plays the
      // units ace-media wrote (its own profile and level, from VideoToolbox's avcC).
      const written = m.units[0]?.frame.codecString ?? "";
      expect(written.startsWith("avc1.")).toBe(true);
      await until(
        () => v.chunks.filter((chunk) => chunk.codec === written).length >= 20,
        "the viewer's video from ace-media",
      );
      expect(m.units.every((u) => u.frame.kind === 1 && u.frame.codec === 2)).toBe(true);
      const steps = m.statuses
        .flatMap((s) =>
          typeof s === "object" && s && "acceleration" in s
            ? [
                (
                  s as {
                    acceleration?: {
                      steps: { step: string; backend: string; hardware: boolean }[];
                    };
                  }
                ).acceleration,
              ]
            : [],
        )
        .at(-1)?.steps;
      expect(steps?.find((s) => s.step === "encode")).toMatchObject({
        backend: "vt",
        hardware: true,
      });
      const decoded = await decode(
        f,
        v.chunks.filter((chunk) => chunk.codec === written),
      );
      expect(decoded.errors).toEqual([]);
      expect(decoded.pictures).toBe(decoded.chunks);
    },
    90_000,
  );
});
