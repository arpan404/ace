import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EgressUnit } from "@ace/media/egress";
import type { MediaOwner } from "@ace/media/media-connections";
import { MediaRuntime } from "@ace/media/runtime";
import {
  defaultMediaSettings,
  nodeMediaHost,
  systemMediaClock,
  type MediaSettings,
} from "@ace/media/supervisor";
import { MediaTestClient } from "@ace/media/testing/media-test-client";
import type { BrowserServerMessage, BrowserState } from "@ace/protocol";
import { connectBrowser } from "./index.ts";
import { noMedia, type BrowserMedia } from "./media-video.ts";
import { decodeStreamMessage, StreamAssembler } from "./stream.ts";
import type { BrowserVideoChunk } from "./stream-video.ts";
import { executablePath, fixture } from "./test-support.ts";

// Live video through the real ace-media (E4, X2): a tab of ace's Chrome streams its WebCodecs
// chunks through the video extension's WebSocket into the binary, and its units come back on
// egress; a private-context tab's screencast is encoded by ace-media itself, its pictures on the
// source's ingest. ace-media delivers the view itself, on a client's media connection (X3). Real
// edges a unit test can't cover: Chrome's WebSocket from the extension origin, the binary's
// ingest, egress and media connection, and a producer reconnecting to a new ace-media after a
// kill. Runs when
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
  const units: EgressUnit[] = [];
  const statuses: unknown[] = [];
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
    platform: process.platform,
    log: () => {},
    onMessage: (message) => {
      if (message.type === "source.status") statuses.push(message);
    },
  });
  const browser: BrowserMedia = {
    add: (producer) =>
      runtime.sources.add({
        ...producer,
        consumers: {
          ...producer.consumers,
          deliver: (unit) => {
            units.push(unit);
            producer.consumers.deliver(unit);
          },
        },
      }),
    routed: (kind) => runtime.sources.routed(kind),
    wanted: (kind) => runtime.sources.wanted(kind),
    pictureCodecs: () => runtime.pictureCodecs(),
    endpoint: () => runtime.sources.endpoint(),
  };
  cleanups.push(() => {
    runtime.dispose();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  runtime.settingsChanged();
  return { runtime, browser, units, statuses };
}

const owner: MediaOwner = {
  session: "main-1",
  device: "phone",
  admission: { kind: "pairing", generation: "3f9a1c0e7b2d4a6c8e1f0b2d4c6e8a1f" },
};

/**
 * A viewer on this machine that asks for H.264 on its media connection, as a client does: the
 * browser's state on its socket, the video from ace-media, every chunk acknowledged at once.
 * `subscribe` connects and binds again, as a client does after its media connection closed.
 */
function viewer(f: Awaited<ReturnType<typeof fixture>>, runtime?: MediaRuntime) {
  const chunks: { chunk: BrowserVideoChunk; at: number }[] = [];
  const states: { state: BrowserState; at: number }[] = [];
  const results: Extract<BrowserServerMessage, { type: "browser.result" }>[] = [];
  let client: MediaTestClient | undefined;
  let subscribes = 0;
  const bridge = connectBrowser(f.service, {
    connectionId: "viewer",
    authorize: () => true,
    send: (message) => {
      if (message.type === "browser.state")
        states.push({ state: message.state, at: performance.now() });
      if (message.type === "browser.result") results.push(message);
      return true;
    },
    sendStream: () => true,
    ...(runtime ? { media: { owner: () => owner, delivery: () => runtime.delivery() } } : {}),
  });
  const subscribe = async (connection?: string) =>
    bridge.handle({
      type: "browser.subscribe",
      threadId: "thread",
      requestId: `subscribe-${++subscribes}`,
      binaryFrames: true,
      viewport: { width: 640, height: 400, devicePixelRatio: 1 },
      video: { codecs: ["avc1.42E033"] },
      mediaClient: true,
      ...(connection ? { media: { connection } } : {}),
    });
  return {
    get chunks() {
      return chunks.map((entry) => entry.chunk);
    },
    timed: chunks,
    states,
    results,
    closed: () => client?.closed(),
    subscribe: async () => {
      if (!runtime) return subscribe();
      const grant = await runtime.connections.connect(owner);
      if (!grant.ok) throw new Error(`media.connect: ${grant.code}`);
      const assembler = new StreamAssembler();
      let opened: MediaTestClient | undefined;
      opened = await MediaTestClient.open(grant, {
        onPiece: (piece) => {
          const envelope = assembler.push(piece);
          const message = envelope && decodeStreamMessage(envelope);
          if (message?.kind !== "browser.video") return;
          chunks.push({ chunk: message.chunk, at: performance.now() });
          opened?.send({
            type: "browser.ack",
            threadId: "thread",
            sequence: message.chunk.sequence,
            video: true,
          });
        },
      });
      client = opened;
      const made = opened;
      cleanups.push(() => made.close());
      return subscribe(grant.connection);
    },
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
  it("a tab streams only through ace-media; killed, the view says it is retrying and the picture is back on the new ace-media within 2 s", async () => {
    const m = media(defaultMediaSettings);
    const f = await fixture({ media: m.browser });
    await f.navigate();
    await f.service.execute("thread", { action: "resize", width: 640, height: 400 });
    const v = viewer(f, m.runtime);
    await v.subscribe();
    await f.evaluate(animate);

    // Chunks come back from ace-media's egress, binary end to end: every one the viewer got.
    await until(() => m.units.length >= 30, "units on egress");
    expect(m.runtime.routes.routes().tab.producer).toBe("ace-media");
    const unit = m.units.find((u) => (u.frame.flags & 1) !== 0);
    expect(unit?.frame).toMatchObject({ kind: 1, codec: 2 });
    expect(unit?.frame.codecString.startsWith("avc1.")).toBe(true);
    await until(() => v.chunks.length >= 30, "the viewer's video");
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

    // ace-media killed: nothing streams anywhere until the new one is up, the view says why,
    // and the producer reconnects to the new ingest with a picture back within 2 s.
    const pid = m.runtime.supervisor.snapshot().pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    const killed = performance.now();
    process.kill(pid, "SIGKILL");
    await until(() => m.runtime.routes.routes().tab.producer === "none", "the stopped route");
    // The media connection went with the process: the client connects and subscribes again as
    // soon as ace-media takes grants.
    await v.closed();
    for (let connected = false; !connected;)
      try {
        await v.subscribe();
        connected = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    await until(
      () => v.states.some((entry) => entry.at > killed && entry.state.video?.status === "retrying"),
      "the view's retrying status",
      5_000,
    );
    const said = v.states.find((entry) => entry.at > killed && entry.state.video)?.state.video;
    expect(said?.reason).toMatch(/ace-media/);
    await until(
      () => v.timed.some((entry) => entry.at > killed && entry.chunk.key),
      "a keyframe from the new ace-media",
      5_000,
    );
    const back = v.timed.find((entry) => entry.at > killed && entry.chunk.key);
    expect((back?.at ?? Infinity) - killed).toBeLessThan(2_000);
    expect(m.runtime.supervisor.snapshot().pid).not.toBe(pid);
    // Playing again, the view no longer says it is retrying.
    await until(() => v.states.at(-1)?.state.video === undefined, "the status cleared", 5_000);
  }, 90_000);

  it.runIf(process.platform === "darwin")(
    "a private-context tab's screencast is encoded by ace-media on VideoToolbox once it is up, and the viewer plays its units",
    async () => {
      const m = media(defaultMediaSettings);
      const f = await fixture({ media: m.browser, profilePreference: () => "ephemeral" });
      await f.navigate();
      await f.service.execute("thread", { action: "resize", width: 640, height: 400 });
      const v = viewer(f, m.runtime);
      await v.subscribe();
      await f.evaluate(animate);
      await until(() => m.units.length >= 20, "units from ace-media's encoder", 30_000);
      // The viewer plays the units ace-media wrote (its own profile and level, from
      // VideoToolbox's avcC); no encoder of the browser's ever ran for this tab.
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

describe.runIf(executablePath)("live video without ace-media", () => {
  it("without ace-media a tab's view says why it has no video, and agent tools still work", async () => {
    const f = await fixture({ media: noMedia });
    await f.navigate();
    const v = viewer(f);
    await v.subscribe();
    // ace-media is the only delivery (X3): the subscribe's reply says why there are no pictures.
    await until(() => v.results.length > 0, "the subscribe's reply");
    expect(v.results[0]).toMatchObject({
      ok: true,
      undelivered: { reason: expect.stringMatching(/\S/) },
    });
    expect(v.chunks).toEqual([]);
    // The agent's own tools never wait on video.
    const shot = await f.service.execute("thread", { action: "screenshot" });
    expect(shot).toBeTruthy();
    await f.service.execute("thread", { action: "resize", width: 640, height: 400 });
  }, 60_000);
});
