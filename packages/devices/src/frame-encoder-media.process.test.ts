/*
 * An Android emulator's picture through ace-media (E3b), every edge real but the emulator: the
 * screen helper's `--encode-frames` encoding a picture file this test writes, the built
 * ace-media binary, its ingest and egress, and the shared sources and path merge. What only
 * this can show: the helper's units are accepted and come back on egress, route flips between
 * its stdout and ace-media lose and repeat no unit, and a killed ace-media puts the units back
 * on stdout within 2 s. Runs on macOS when ACE_MEDIA_TEST_BINARY names a built ace-media.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { readProducerStamp } from "@ace/media/producer-stamp";
import { MediaRuntime } from "@ace/media/runtime";
import { nodeMediaHost, systemMediaClock } from "@ace/media/supervisor";
import { probeOutput, spawnRawSupervised } from "@ace/provider-kit/process";
import { startFrameEncoder } from "./frame-encoder.ts";
import { DeviceVideoPaths } from "./media-paths.ts";

const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;
const helper = new URL("../../../native/screen-helper/", import.meta.url).pathname;

async function until(condition: () => boolean, ms = 15_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it.runIf(process.platform === "darwin" && !!binary)(
  "an emulator's host-encoded picture streams only through ace-media and back, every unit once, and after ace-media is killed the picture is back on the new one within 2 s",
  { timeout: 120_000 },
  async () => {
    expect((await probeOutput("sh", [join(helper, "build.sh")], { timeoutMs: 300_000 })).code).toBe(
      0,
    );
    const directory = mkdtempSync(join(tmpdir(), "ace-e3b-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const width = 320,
      height = 640;
    const file = join(directory, "frames.rgba");
    const picture = Buffer.alloc(width * height * 4);
    writeFileSync(file, picture);

    const resumed: string[] = [];
    const runtime = new MediaRuntime({
      version: execFileSync(binary ?? "", ["--version"])
        .toString()
        .trim(),
      binary: binary ?? "",
      runtimeDir: directory,
      dataDir: directory,
      host: nodeMediaHost(process.env, (path) => ({ command: path, args: [] })),
      clock: systemMediaClock,
      random: Math.random,
      randomBytes: (length: number) => new Uint8Array(randomBytes(length)),
      id: randomUUID,
      listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
      log: () => {},
      onMessage: (message) => {
        if (message.type === "source.keyframe" && message.reason === "resume")
          resumed.push(message.source);
      },
      capabilities: {
        ingest: ["emulator-frames"],
        delivery: false,
      },
    });
    onTestFinished(() => runtime.dispose());

    // Each picture's `ts` is its number, so a unit's `pts` names it whichever way it came.
    const handed: { number: number; at: number; egress: boolean; keyframe: boolean }[] = [];
    const viaEgress = new Set<number>();
    /** How each ace-media path ended: clean (its end frame came) or interrupted. */
    const ended: { at: number; interrupted: boolean }[] = [];
    let paths: DeviceVideoPaths | undefined;
    const encoder = startFrameEncoder({
      encoder: join(helper, "build/ace-screen-helper"),
      file,
      runtime: { spawn: spawnRawSupervised },
      env: process.env,
      failed: () => {},
      ingestClosed: () => paths?.ingestClosed(),
    });
    onTestFinished(() => encoder.stop());
    encoder.bitrate(2_000_000);
    paths = new DeviceVideoPaths({
      media: {
        attach: (producer) =>
          runtime.sources.add({
            ...producer,
            pathEnded: (path, interrupted) => {
              ended.push({ at: performance.now(), interrupted });
              producer.pathEnded?.(path, interrupted);
            },
            consumers: {
              ...producer.consumers,
              deliver: (unit) => {
                const stamp = readProducerStamp(unit.frame.extension);
                if (stamp) viaEgress.add(stamp.timestamp);
                producer.consumers.deliver(unit);
              },
            },
          }),
      },
      source: "emulator:test",
      kind: "emulator-frames",
      origin: { kind: "emulator-frames", path: file, width, height, stride: width * 4 },
      deviceId: "emulator-5554",
      emit: (unit) => {
        const number = Number(unit.pts / 1000n);
        handed.push({
          number,
          at: performance.now(),
          egress: viaEgress.has(number),
          keyframe: unit.keyframe,
        });
      },
      switch: (address) =>
        encoder.ingest(
          address
            ? { socket: address.socket, token: Buffer.from(address.token).toString("base64") }
            : undefined,
        ),
      keyframe: () => encoder.keyframe(),
      schedule: (callback, ms) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    });
    onTestFinished(() => paths?.close());

    // The emulator: a new picture every 33 ms.
    let number = 0;
    const timer = setInterval(() => {
      number++;
      picture.fill(number & 0xff);
      writeFileSync(file, picture);
      encoder.frame({ seq: number, width, height, ts: number });
    }, 33);
    onTestFinished(() => clearInterval(timer));

    const egressed = () => handed.filter((entry) => entry.egress);
    await until(() => egressed().length >= 20);
    expect(runtime.supervisor.health()).toBe("healthy");

    // Nothing ever comes from anywhere but ace-media's egress.
    expect(handed.every((entry) => entry.egress)).toBe(true);
    // Every picture once, in order, none missing (the encoder may skip pictures while its first
    // session starts). A new path starts at a keyframe, which the encoder makes of the last
    // picture again when no newer one waits: that is the only unit that may name a picture
    // already handed on.
    const repeats = handed.filter(
      (entry, index) => index > 0 && entry.number === handed[index - 1]?.number,
    );
    expect(repeats.every((entry) => entry.keyframe)).toBe(true);
    const numbers = [...new Set(handed.map((entry) => entry.number))];
    const first = numbers[0] ?? 0;
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => first + index));
    expect(ended.filter((end) => end.interrupted)).toEqual([]);
    // Each newly opened ingest must begin with its switch keyframe, even if a delta was
    // still encoding when the route command arrived. Otherwise its gate loses that unit.
    expect(resumed).toEqual([]);

    const pid = runtime.supervisor.snapshot().pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    const killed = performance.now();
    process.kill(pid, "SIGKILL");
    // The encoder reconnects to the new ace-media's ingest: the picture is back within 2 s.
    await until(() => handed.some((entry) => entry.at > killed), 10_000);
    const back = handed.find((entry) => entry.at > killed);
    expect((back?.at ?? Infinity) - killed).toBeLessThan(2_000);
    expect(back?.egress).toBe(true);
    expect(runtime.supervisor.snapshot().pid).not.toBe(pid);
    // The killed process's path ended in failure: interrupted.
    expect(ended.filter((end) => end.at > killed).some((end) => end.interrupted)).toBe(true);
  },
);
