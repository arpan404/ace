import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import type { Frame } from "@ace/screen";
import { DevicesService } from "./index.ts";
import { simulatorCapture } from "./simulator-capture.ts";
import { FakeSimPlatform } from "./testing/fake-sim.ts";
import { fakeServeSim } from "./testing/fake-serve-sim.ts";
import { firstRed, flatJpeg, mediaBinary } from "./testing/media-images.ts";

/* Screens are made and read by ace-media (ADR 0201); without a built binary these don't run. */
const drawn = it.skipIf(!mediaBinary);

const ios = "ios:00000000-0000-4000-8000-00000000F00D";
const person = { kind: "human", owner: "person" } as const;

/** A screen painted one flat colour, as serve-sim's MJPEG would carry it. */
const screen = (red: number) => flatJpeg(201, 437, [red, 0, 0]);

drawn(
  "an unwatched Simulator receives no pictures while idle, yet a screenshot shows the screen as it is now",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "sim-stills-"));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const sim = await fakeServeSim(home, "0.1.49-beta.139.1", ios.slice(4));
    const published: Frame[] = [];
    let id = 0;
    const service = new DevicesService({
      platform: new FakeSimPlatform(home),
      env: {},
      runtime: {
        now: () => performance.now(),
        id: () => `stream-${++id}`,
        spawn: spawnRawSupervised,
        after(ms, run) {
          const timer = setTimeout(run, ms);
          return () => clearTimeout(timer);
        },
      },
      capture: (options) =>
        simulatorCapture({
          ...options,
          command: sim.command,
          env: { PATH: home },
          publish: (frame) => {
            published.push(frame);
            options.publish(frame);
          },
        }),
      recordingDirectory: home,
      async publishArtifact() {
        throw new Error("Not recording");
      },
    });
    onTestFinished(() => service.close());
    await service.request({ op: "enable", enabled: true }, person);
    await service.request({ op: "start", deviceId: ios, fps: 30 }, person);
    // Nobody watches or records: serve-sim's picture stream is closed.
    await expect.poll(() => sim.mjpegOpen()).toBe(0);

    // An agent scrolls for a second: serve-sim sends a change every frame, and nobody watches.
    const frames = await Promise.all(Array.from({ length: 30 }, (_, index) => screen(index)));
    const before = published.length;
    for (const frame of frames) {
      sim.paint(frame);
      await new Promise((resolve) => setTimeout(resolve, 33));
    }
    const busy = published.length - before;
    // The final change, and at once a screenshot: it must show that change, not an older one.
    const final = await screen(255);
    sim.paint(final);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const shot = await service.screenshot(ios, person);
    expect(await firstRed(shot.payload)).toBeGreaterThan(200);
    // Not a still per change, nor a heartbeat: nothing until asked.
    expect(busy).toBe(0);
    expect(sim.mjpegOpen()).toBe(0);
  },
);
