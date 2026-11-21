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
import { nodeMediaHost, systemMediaClock, type MediaSettings } from "@ace/media/supervisor";
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
  "an Android device's units are forwarded to ace-media and come back as today's frames, four route flips lose and repeat none, and a killed ace-media hands them back within 2 s",
  { timeout: 120_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "ace-e3b-scrcpy-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const settings: MediaSettings = {
      encode: "auto",
      delivery: "auto",
      recordings: "auto",
      stills: "auto",
    };
    const runtime = new MediaRuntime({
      version: execFileSync(binary ?? "", ["--version"])
        .toString()
        .trim(),
      binary: binary ?? "",
      runtimeDir: directory,
      dataDir: directory,
      settings: () => settings,
      host: nodeMediaHost(process.env, (path) => ({ command: path, args: [] })),
      clock: systemMediaClock,
      random: Math.random,
      randomBytes: (length: number) => new Uint8Array(randomBytes(length)),
      id: randomUUID,
      listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
      log: () => {},
      capabilities: { ingest: ["scrcpy"], delivery: false },
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

    for (const encode of ["legacy", "auto", "legacy", "auto"] as const) {
      const before = video().length;
      settings.encode = encode;
      runtime.settingsChanged();
      await until(
        () =>
          video()
            .slice(before)
            .filter(([, egress]) => egress === (encode === "auto")).length >= 5,
      );
    }
    // Every unit the device sent from the first one through ace-media on arrived once, in order.
    const marks = video().map(([frame]) => markOf(frame));
    const first = video().findIndex(([, egress]) => egress);
    const run = marks.slice(Math.max(0, first - 1));
    expect(run).toEqual(Array.from({ length: run.length }, (_, index) => (run[0] ?? 0) + index));

    const pid = runtime.supervisor.snapshot().pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    const killed = performance.now();
    const before = video().length;
    process.kill(pid, "SIGKILL");
    await until(
      () =>
        video()
          .slice(before)
          .some(([, egress]) => !egress),
      5_000,
    );
    expect(performance.now() - killed).toBeLessThan(2_000);
    const back = video()
      .slice(before)
      .find(([, egress]) => !egress)?.[0];
    expect(back?.header.keyframe).toBe(true);
  },
);
