/*
 * An Android device through ace-media (E3b) against the real binary. The daemon keeps scrcpy's
 * sockets (a fake device on a real local TCP socket here) and, while the route says ace-media,
 * forwards each unit unchanged to its ingest; egress brings them back to the capture. What only
 * the binary can show: the forwarded units accepted and returned with today's headers, four
 * route flips that lose and repeat no unit, and the daemon taking the units back within 2 s of
 * ace-media being killed. Runs when ACE_MEDIA_TEST_BINARY names a built ace-media.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { MediaRuntime } from "@ace/media/runtime";
import type { RouteCapabilities } from "@ace/media/routes";
import { nodeMediaHost, systemMediaClock } from "@ace/media/supervisor";
import type { Frame } from "@ace/screen";
import { fixture, media, nal, type Cleanup } from "./testing/fake-scrcpy.ts";

const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;
const cleanup: Cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function until(condition: () => boolean, ms = 15_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A unit's mark: its last two payload bytes. */
const markOf = (frame: Frame) => frame.payload.readUInt16BE(frame.payload.length - 2);

it.runIf(!!binary)(
  "an Android device's units are forwarded only to ace-media and come back as today's frames, none lost or repeated, and after ace-media is killed they are back through the new one within 2 s",
  { timeout: 120_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "ace-e3b-scrcpy-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    // A route flips when the kind's producer can or can't stream into ace-media; no setting
    // chooses it.
    const capabilities: RouteCapabilities = { ingest: ["scrcpy"], delivery: false };
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
      capabilities,
    });
    onTestFinished(() => runtime.dispose());

    // Units come back on egress synchronously into the capture's publish.
    let fromEgress = false;
    const published = new Map<Frame, boolean>();
    const { device } = await fixture(cleanup, {
      now: () => performance.now(),
      onFrame: (frame) => void published.set(frame, fromEgress),
      media: {
        attach: (producer) =>
          runtime.sources.add({
            ...producer,
            consumers: {
              ...producer.consumers,
              deliver: (unit) => {
                fromEgress = true;
                try {
                  producer.consumers.deliver(unit);
                } finally {
                  fromEgress = false;
                }
              },
            },
          }),
      },
    });
    // The device: a delta every 20 ms, numbered, and a keyframe for every resetVideo.
    let mark = 1000;
    let resets = 0;
    const timer = setInterval(() => {
      const control = device.control();
      for (; resets < control.length; resets++)
        if (control[resets] === 17)
          device.video(media(0x20, nal(0x65, (++mark >> 8) & 0xff, mark & 0xff)));
      device.video(media(0x00, nal(0x41, (++mark >> 8) & 0xff, mark & 0xff)));
    }, 20);
    onTestFinished(() => clearInterval(timer));
    const video = () => [...published].filter(([frame]) => frame.header.codec === "h264");

    await until(() => video().filter(([, egress]) => egress).length >= 5);
    const key = video().find(([frame, egress]) => egress && frame.header.keyframe)?.[0];
    expect(key?.header).toMatchObject({
      codec: "h264",
      keyframe: true,
      videoCodec: "avc1.42C029",
      width: 540,
      height: 1200,
      scale: 0.5,
    });

    // Every unit came through ace-media, once and in order from its first keyframe.
    expect(video().every(([, egress]) => egress)).toBe(true);
    const run = video().map(([frame]) => markOf(frame));
    expect(run).toEqual(Array.from({ length: run.length }, (_, index) => (run[0] ?? 0) + index));

    const pid = runtime.supervisor.snapshot().pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    const killed = performance.now();
    const before = video().length;
    process.kill(pid, "SIGKILL");
    // The daemon forwards to the new ace-media's ingest: back from its keyframe within 2 s.
    await until(() => video().length > before, 10_000);
    expect(performance.now() - killed).toBeLessThan(2_000);
    const [back, egress] = video()[before] ?? [];
    expect(egress).toBe(true);
    expect(back?.header.keyframe).toBe(true);
    expect(runtime.supervisor.snapshot().pid).not.toBe(pid);
  },
);
