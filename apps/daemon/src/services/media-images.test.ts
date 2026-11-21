import { ImageError } from "@ace/media/images";
import type { MediaChild, MediaClock } from "@ace/media/supervisor";
import { decodeToMedia, encodeControl, type FromMedia } from "@ace/media/wire";
import { expect, test } from "vitest";
import { createDaemonImages, imageWorkerEnv } from "./media-images.ts";

/*
 * ADR 0208 §6: the daemon's image work is ace-media's image process on every OS. The media
 * process may not run on Windows yet; images must, so previews, icons and screenshot fitting
 * work there too.
 */

const clock: MediaClock = {
  now: () => 0,
  setTimeout: () => () => {},
};

/** A child that answers each image job with a 2 × 1 probe result. */
function answering(spawned: { args: readonly string[] }[]) {
  return (_binary: string, args: readonly string[]): MediaChild => {
    spawned.push({ args });
    const stdout: ((chunk: Uint8Array) => void)[] = [];
    let buffered = new Uint8Array(0);
    const reply = (message: FromMedia) => {
      const { header } = encodeControl(message, new Uint8Array(0), "normal");
      for (const listener of stdout) listener(header);
    };
    return {
      pid: 4242,
      stdin: {
        write(chunk, done) {
          const joined = new Uint8Array(buffered.length + chunk.length);
          joined.set(buffered);
          joined.set(chunk, buffered.length);
          buffered = joined;
          const length = buffered.length >= 4 ? new DataView(buffered.buffer).getUint32(0) : -1;
          if (length >= 0 && buffered.length >= 4 + length) {
            const { message } = decodeToMedia(buffered.slice(0, 4 + length), "normal");
            buffered = buffered.slice(4 + length);
            if (message.type === "image.job")
              queueMicrotask(() =>
                reply({
                  type: "image.done",
                  request: message.request,
                  width: 2,
                  height: 1,
                  format: "none",
                  source: { format: "png", width: 2, height: 1, orientation: 1 },
                }),
              );
          }
          queueMicrotask(() => done());
          return true;
        },
        onDrain() {},
      },
      stdout: { onData: (listener) => void stdout.push(listener), onEnd() {} },
      stderr: { onData() {}, onEnd() {} },
      exited: new Promise(() => {}),
      kill() {},
    };
  };
}

const probe = {
  inputs: [{ kind: "bytes" as const, bytes: new Uint8Array([1]) }],
  op: { op: "probe" as const, maxPixels: 16 },
  deadlineMs: 5_000,
};

test("on Windows the image process starts on the first image job and answers it", async () => {
  const spawned: { args: readonly string[] }[] = [];
  let ids = 0;
  const images = createDaemonImages({
    binary: "C:\\Program Files\\ace\\media\\ace-media.exe",
    root: "C:\\Users\\me\\.ace",
    platform: "win32",
    spawn: answering(spawned),
    clock,
    id: () => `i${++ids}`,
    random: () => 0.5,
    log: () => {},
  });
  expect(spawned).toEqual([]);
  await expect(images.run(probe)).resolves.toMatchObject({ width: 2, height: 1 });
  expect(spawned).toEqual([{ args: ["--images", "--root", "C:\\Users\\me\\.ace"] }]);
  images.dispose();
});

test("without an ace-media binary every image job fails at once, saying so", async () => {
  const images = createDaemonImages({
    binary: undefined,
    root: "/home/me/.ace",
    platform: "linux",
    spawn: answering([]),
    clock,
    id: () => "i",
    random: () => 0.5,
    log: () => {},
  });
  const error = await images.run(probe).catch((e: unknown) => e);
  expect(error instanceof ImageError && [error.reason, error.message]).toEqual([
    "unavailable",
    expect.stringContaining("no ace-media binary"),
  ]);
});

test("the image worker sees none of the daemon's environment, only what its OS needs", () => {
  const daemon = {
    ANTHROPIC_API_KEY: "secret",
    GITHUB_TOKEN: "secret",
    HOME: "/home/me",
    PATH: "/usr/bin",
    ACE_HOME: "/home/me/.ace",
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Temp",
  };
  expect(imageWorkerEnv(daemon, "linux")).toEqual({});
  expect(imageWorkerEnv(daemon, "darwin")).toEqual({});
  expect(imageWorkerEnv(daemon, "win32")).toEqual({ SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
});
