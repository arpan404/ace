import { FrameDecoder } from "@ace/screen";
import { z } from "zod";
import type { DaemonUnit, Switched } from "./media-paths.ts";
import type { DeviceRuntime } from "./runtime.ts";
import { DeviceError } from "./sdk.ts";

/**
 * The screen helper's `--encode-frames` process: it encodes the newest picture in a shared RGBA
 * file with the Mac's hardware encoder. Its units come on stdout in the capture's own framing,
 * or go to ace-media's ingest while it has been given an address; each switch is answered on
 * stderr with the last sequence the previous path took.
 */

export interface FrameEncoder {
  /** The file holds a new picture. */
  frame(note: { seq: number; width: number; height: number; ts: number }): void;
  bitrate(bitrate: number): void;
  keyframe(): void;
  /**
   * Sends units to ace-media's ingest (`socket` with its base64 `token`), or back to stdout.
   * Resolves once it has switched, with where it sends now and the previous path's boundary.
   */
  ingest(address: { socket: string; token: string } | undefined): Promise<Switched>;
  stop(): Promise<void>;
}

/** The encoder's word on stderr after an `ingest` command, or when its connection failed. */
const IngestEvent = z.object({
  event: z.literal("ingest"),
  state: z.enum(["on", "off", "closed"]),
  boundary: z.number().int().nonnegative().nullable(),
});

export function startFrameEncoder(options: {
  /** The screen helper. */
  encoder: string;
  /** The shared picture file. */
  file: string;
  runtime: Pick<DeviceRuntime, "spawn">;
  env: NodeJS.ProcessEnv;
  /** A unit off stdout, with its sequence. */
  unit(unit: DaemonUnit): void;
  failed(error: unknown): void;
  /** The ingest connection failed: units come on stdout again. */
  ingestClosed?(): void;
}): FrameEncoder {
  let stopped = false;
  let codec = "avc1.640033";
  const encoder = options.runtime.spawn({
    command: options.encoder,
    args: ["--encode-frames", options.file],
    env: options.env,
    name: "emulator-encoder",
  });
  /** `ingest` commands waiting for the encoder's answer, in order. */
  const switching: ((switched: Switched) => void)[] = [];
  encoder.stderr.on("line", (line: string) => {
    let event: z.infer<typeof IngestEvent>;
    try {
      event = IngestEvent.parse(JSON.parse(line));
    } catch {
      return;
    }
    if (event.state === "closed") options.ingestClosed?.();
    else switching.shift()?.({ ingest: event.state, boundary: event.boundary });
  });
  const command = (value: object) => {
    if (!stopped && encoder.stdin.writable) encoder.stdin.write(`${JSON.stringify(value)}\n`);
  };
  encoder.stdin.on("error", () => {});
  const decoder = new FrameDecoder((frame) => {
    const header = frame.header;
    if (header.codec !== "h264" || stopped) return;
    if (header.videoCodec) codec = header.videoCodec;
    options.unit({
      sequence: header.sequence,
      payload: frame.payload,
      keyframe: header.keyframe === true,
      videoCodec: codec,
      width: header.width,
      height: header.height,
      pts: BigInt(Math.round(header.timestamp * 1000)),
    });
  });
  encoder.stdout.on("data", (chunk: Buffer) => {
    try {
      decoder.push(chunk);
    } catch (error) {
      if (!stopped) options.failed(error);
    }
  });
  void encoder.exited.then(() => {
    for (const resolve of switching.splice(0)) resolve({ ingest: "off", boundary: null });
    if (!stopped)
      options.failed(
        new DeviceError(
          "command_failed",
          "The emulator's encoder stopped",
          "Start the device view again.",
        ),
      );
  });
  return {
    frame: (note) => command({ op: "frame", ...note }),
    bitrate: (bitrate) => command({ op: "bitrate", bitrate }),
    keyframe: () => command({ op: "keyframe" }),
    ingest: (address) =>
      new Promise<Switched>((resolve, reject) => {
        if (stopped) return reject(new Error("The emulator's encoder stopped"));
        switching.push(resolve);
        command(address ? { op: "ingest", ...address } : { op: "ingest" });
      }),
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const resolve of switching.splice(0)) resolve({ ingest: "off", boundary: null });
      encoder.stdin.end();
      await encoder.stop({ graceMs: 1000 }).catch(() => {});
    },
  };
}
