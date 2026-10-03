import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { framePacket } from "@ace/screen";
import { findExecutable } from "@ace/provider-kit/discovery";
import { renderDeviceVideo } from "./index.ts";

const execute = promisify(execFile);
// No discovery or child process starts unless the owner explicitly opts in.
it.skipIf(process.env["ACE_DEVICE_VIDEO_LIVE"] !== "1")(
  "real device MP4 decodes every color in capture order at its original frame times",
  async () => {
    const ffmpeg = await findExecutable("ffmpeg", process.env);
    const ffprobe = await findExecutable("ffprobe", process.env);
    if (!ffmpeg || !ffprobe) throw new Error("Opt-in video validation requires ffmpeg and ffprobe");
    const directory = await mkdtemp(join(tmpdir(), "ace-device-real-video-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const packets: Buffer[] = [];
    for (const [sequence, timestamp, rgb] of [
      [0, 1000, [255, 0, 0]],
      [1, 1240, [0, 255, 0]],
      [2, 1800, [0, 0, 255]],
    ] as const) {
      // Our own solid-color pixels become a valid JPEG through the real codec.
      const pixels = Buffer.alloc(64 * 64 * 3);
      for (let offset = 0; offset < pixels.length; offset += 3) pixels.set(rgb, offset);
      const source = join(directory, `${sequence}.ppm`);
      const image = join(directory, `${sequence}.jpg`);
      await writeFile(source, Buffer.concat([Buffer.from("P6\n64 64\n255\n"), pixels]));
      await execute(ffmpeg, ["-loglevel", "error", "-y", "-i", source, "-frames:v", "1", image], {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      const payload = await readFile(image);
      packets.push(
        framePacket(
          {
            version: 2,
            sessionId: "capture",
            seq: sequence,
            ts: timestamp,
            width: 64,
            height: 64,
            scale: 1,
            codec: "jpeg",
            bytes: payload.length,
          },
          payload,
        ),
      );
    }
    const path = join(directory, "colors.ace-screen");
    const source = Buffer.concat(packets);
    await writeFile(path, source);
    const artifact = await renderDeviceVideo(
      {
        id: "colors",
        path,
        bytes: source.length,
        mimeType: "application/vnd.ace.screen",
      },
      process.env,
      { ffmpeg },
    );
    const probe = await execute(
      ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_streams",
        "-show_entries",
        "frame=best_effort_timestamp_time:stream=codec_name,duration",
        "-of",
        "json",
        artifact.path,
      ],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    const metadata = z
      .object({
        streams: z.array(z.object({ codec_name: z.string(), duration: z.coerce.number() })),
        frames: z.array(z.object({ best_effort_timestamp_time: z.coerce.number() })),
      })
      .parse(JSON.parse(probe.stdout));
    expect(metadata.streams[0]?.codec_name).toBe("h264");
    const duration = metadata.streams[0]?.duration;
    if (duration === undefined) throw new Error("Missing real video duration");
    expect(duration).toBeGreaterThanOrEqual(0.84);
    expect(duration).toBeLessThanOrEqual(1.04);
    for (const expected of [0, 0.24, 0.8])
      expect(
        metadata.frames.some(
          (frame) => Math.abs(frame.best_effort_timestamp_time - expected) < 0.041,
        ),
      ).toBe(true);
    for (const [timestamp, dominant] of [
      [0, 0],
      [0.3, 1],
      [0.82, 2],
    ] as const) {
      const decoded = await execute(
        ffmpeg,
        [
          "-loglevel",
          "error",
          "-ss",
          String(timestamp),
          "-i",
          artifact.path,
          "-vf",
          "crop=720:720:280:0,scale=1:1",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ],
        { encoding: "buffer", timeout: 30000, maxBuffer: 1024 * 1024 },
      );
      expect(decoded.stdout.length).toBe(3);
      for (let channel = 0; channel < 3; channel++)
        if (channel === dominant) expect(decoded.stdout[channel]).toBeGreaterThan(220);
        else expect(decoded.stdout[channel]).toBeLessThan(35);
    }
    expect(await readFile(path)).toEqual(source);
  },
  120000,
);
