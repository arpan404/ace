import { createHash } from "node:crypto";
import { framePacket, type Frame } from "@ace/screen";
import type { ScreenStreamSettings } from "@ace/protocol";
import type { AppDevice as Device, DeviceInput } from "@ace/protocol/devices";
import { findExecutable as discoverExecutable } from "@ace/provider-kit/discovery";
import type { DeviceCapture } from "./capture.ts";
import type { DevicePlatform } from "./platform.ts";
import type { DeviceRuntime } from "./runtime.ts";
import { DeviceError } from "./sdk.ts";
import { deviceImageStream } from "./stream-control.ts";
import {
  DeviceMessageReader,
  VideoStreamReader,
  encodeControl,
  scrcpyMaxSize,
  type ControlMessage,
  type ServerProfile,
} from "./scrcpy-protocol.ts";
import { ScrcpyVideoUnits, type VideoUnit } from "./scrcpy-video.ts";
import { HeldPointers, scrcpyInputPlan } from "./scrcpy-input.ts";
import { startScrcpyServer, type ScrcpyConnection } from "./scrcpy-server.ts";
import { H264Jpeg } from "./h264-jpeg.ts";
import { ScrcpyClipboard } from "./scrcpy-clipboard.ts";
import type { EmulatorGrpc } from "./emulator-discovery.ts";
import { startHostFrames, type HostFrames } from "./host-frames.ts";

/** Control bytes queued in the socket before input is refused rather than delayed. */
const controlBacklog = 256 * 1024;
/** A keyframe request restarts the device encoder; repeat one only when it went unanswered. */
const keyframeRetryMs = 1000;

type Link = {
  connection: ScrcpyConnection;
  units: ScrcpyVideoUnits;
  profile: ServerProfile;
  clipboard: ScrcpyClipboard;
  /** The server crashes on a video reset before its first frame, which is a keyframe anyway. */
  streaming: boolean;
  /** When this server run started (runtime clock). */
  startedAt: number;
  /** The picture encoded on the host; the server then runs control only. */
  frames: HostFrames | undefined;
};

/** The picture's size: the host-encoded one's, else what scrcpy's stream said. */
const pictureSize = (link: Link) => link.frames?.size ?? link.units.size;

function profileFor(
  settings: ScreenStreamSettings,
  display: { width: number; height: number },
  scid: number,
): ServerProfile {
  return {
    scid,
    maxSize: scrcpyMaxSize(display, settings),
    bitrate: settings.bitrate,
    fps: settings.fps,
  };
}
/**
 * Whether a new profile is worth restarting the server, which costs a second or more without
 * a picture. A new size or frame rate always is. A bit rate alone (a viewer's link moving) is
 * only when it changes by half or more and the server has run for 10 s, so a link that wavers
 * never keeps the view restarting.
 */
export function scrcpyRestartWorthIt(
  current: ServerProfile,
  wanted: ServerProfile,
  runningMs: number,
): boolean {
  if (current.maxSize !== wanted.maxSize || current.fps !== wanted.fps) return true;
  if (current.bitrate === wanted.bitrate) return false;
  const ratio =
    Math.max(current.bitrate, wanted.bitrate) / Math.min(current.bitrate, wanted.bitrate);
  return ratio >= 1.5 && runningMs >= 10_000;
}

/**
 * Android view and control through the pinned scrcpy server. H.264 from the device's encoder is
 * passed through to viewers as it arrives; input goes over the server's control socket.
 */
export async function scrcpyCapture(options: {
  device: Device;
  streamId: string;
  fps: number;
  jar: string;
  platform: DevicePlatform;
  runtime: DeviceRuntime;
  env: NodeJS.ProcessEnv;
  publish(frame: Frame): void;
  failure(error: unknown): void;
  signal?: AbortSignal;
  /**
   * Encode the picture on the host (an emulator ace booted with gRPC, the Mac's screen helper):
   * the emulator's software encoder starves when the Mac is busy. Absent, or failing to start,
   * the picture comes from scrcpy as before.
   */
  host?: { grpc: EmulatorGrpc; encoder: string; directory: string };
}): Promise<DeviceCapture> {
  const { runtime, platform, device } = options;
  const transport = await platform.captureTransport(device);
  options.signal?.throwIfAborted();
  const serial = transport.serial;
  const longEdge = Math.max(transport.width, transport.height);
  const shortEdge = Math.min(transport.width, transport.height);
  /** The display in the orientation of a frame of this size. */
  const displayFor = (width: number, height: number) =>
    width >= height
      ? { width: longEdge, height: shortEdge }
      : { width: shortEdge, height: longEdge };
  let settings: ScreenStreamSettings = { ...deviceImageStream, codec: "h264", fps: options.fps };
  let link: Link | undefined;
  let jpeg: H264Jpeg | undefined;
  let stopped = false;
  let terminated = false;
  let sequence = 0;
  let keyframeAsked = -Infinity;
  let restarting: Promise<void> | undefined;
  let unwatch: (() => void) | undefined;
  const held = new HeldPointers();
  const scid = () =>
    createHash("sha256").update(runtime.id()).digest().readUInt32BE(0) & 0x7fffffff;

  /** Why there is no control link: a restart in progress, or a capture that has ended. */
  const unavailable = () =>
    stopped
      ? new DeviceError(
          "command_failed",
          "The Android screen stream ended",
          "Start the device view again.",
        )
      : new DeviceError("busy", "Android control is reconnecting", "Retry the action.");
  const fail = (error: unknown) => {
    if (stopped) return;
    options.failure(error);
    void stop().catch(() => {});
  };
  const send = (message: ControlMessage, current = link) => {
    const control = current?.connection.control;
    if (!control || control.destroyed) throw unavailable();
    if (control.writableLength > controlBacklog)
      throw new DeviceError("busy", "Android input backlog exceeded limit", "Retry the action.");
    control.write(encodeControl(message));
  };
  const keyframe = () => {
    const now = runtime.now();
    if (now - keyframeAsked < keyframeRetryMs) return;
    if (!link?.streaming) return;
    keyframeAsked = now;
    if (link.frames) return link.frames.keyframe();
    try {
      send({ type: "resetVideo" });
    } catch {
      // A reconnecting server starts with a keyframe of its own.
    }
  };
  const publishVideo = (unit: VideoUnit) => {
    if (unit.keyframe) keyframeAsked = -Infinity;
    if (jpeg) {
      if (!jpeg.push(unit)) keyframe();
      return;
    }
    const display = displayFor(unit.width, unit.height);
    const header = {
      version: 1 as const,
      sessionId: options.streamId,
      sequence: sequence++,
      timestamp: runtime.now(),
      width: unit.width,
      height: unit.height,
      scale: unit.width / display.width,
      codec: "h264" as const,
      keyframe: unit.keyframe,
      ...(unit.keyframe ? { videoCodec: unit.videoCodec } : {}),
      bytes: unit.payload.length,
    };
    const packet = framePacket(header, unit.payload);
    options.publish({
      header,
      payload: packet.subarray(packet.length - unit.payload.length),
      packet,
    });
  };
  const publishImage = (payload: Buffer, width: number, height: number) => {
    const display = displayFor(width, height);
    const header = {
      version: 1 as const,
      sessionId: options.streamId,
      sequence: sequence++,
      timestamp: runtime.now(),
      width,
      height,
      scale: width / display.width,
      codec: "jpeg" as const,
      bytes: payload.length,
    };
    const packet = framePacket(header, payload);
    options.publish({ header, payload: packet.subarray(packet.length - payload.length), packet });
  };

  /** Starts a server run and makes it the current link before any of its video is read. */
  const connect = async (): Promise<void> => {
    let current: Link | undefined;
    const box = (maxSize: number) => maxSize || longEdge;
    const wanted = profileFor(settings, transport, scid());
    const frames = options.host
      ? await startHostFrames({
          ...options.host,
          display: { width: shortEdge, height: longEdge },
          box: box(wanted.maxSize),
          bitrate: wanted.bitrate,
          runtime,
          env: options.env,
          unit: (unit) => {
            if (!current) return;
            current.streaming = true;
            if (!stopped && link === current) publishVideo(unit);
          },
          failed: (error) => {
            if (current) lost(current, error);
          },
        }).catch(() => undefined)
      : undefined;
    const profile: ServerProfile = { ...wanted, video: frames === undefined };
    const connection = await startScrcpyServer({
      adb: transport.adb,
      serial,
      jar: options.jar,
      profile,
      command: (args, maxBytes, timeoutMs) =>
        platform.transportCommand(device, serial, args, maxBytes, timeoutMs),
      runtime,
      env: options.env,
      ...(options.signal ? { signal: options.signal } : {}),
    }).catch(async (error: unknown) => {
      await frames?.stop();
      throw error;
    });
    const started: Link = {
      connection,
      profile,
      frames,
      startedAt: runtime.now(),
      clipboard: new ScrcpyClipboard({
        send: (message) => send(message, started),
        after: runtime.after,
      }),
      streaming: false,
      units: new ScrcpyVideoUnits(
        (unit) => {
          started.streaming = true;
          if (!stopped && link === started) publishVideo(unit);
        },
        () => {},
      ),
    };
    current = started;
    const reader = new VideoStreamReader((event) => started.units.push(event));
    const messages = new DeviceMessageReader((message) => started.clipboard.received(message));
    const read = (target: { push(chunk: Buffer): void }) => (chunk: Buffer) => {
      try {
        target.push(chunk);
      } catch (error) {
        lost(started, error);
      }
    };
    connection.video?.on("data", read(reader));
    connection.control.on("data", read(messages));
    for (const socket of [connection.video, connection.control]) {
      if (!socket) continue;
      socket.on("error", () => {});
      socket.once("close", () =>
        lost(
          started,
          new DeviceError(
            "command_failed",
            "The Android screen stream ended",
            "Start the device view again.",
          ),
        ),
      );
    }
    void connection.exited.then(() =>
      lost(
        started,
        new DeviceError(
          "command_failed",
          "scrcpy-server stopped on the device",
          "Start the device view again.",
        ),
      ),
    );
    if (stopped) {
      await disconnect(started);
      return;
    }
    link = started;
    if (connection.initialVideo.length) read(reader)(connection.initialVideo);
    if (connection.initialControl.length) read(messages)(connection.initialControl);
    connection.video?.resume();
    connection.control.resume();
  };
  const lost = (current: Link, error: unknown) => {
    if (link !== current || stopped) return;
    fail(error);
  };
  const disconnect = async (current: Link | undefined) => {
    if (!current) return;
    current.clipboard.close();
    await Promise.all([current.frames?.stop(), current.connection.close()]);
  };
  const setImages = async (images: boolean) => {
    if (images && !jpeg) {
      const ffmpeg = await discoverExecutable("ffmpeg", options.env);
      // Without ffmpeg the capture stays H.264, and agents' stills come from the device instead.
      if (!ffmpeg) return false;
      // scrcpy's encoder already keeps to the stream's rate: every picture it sends is one to make.
      jpeg = new H264Jpeg({
        ffmpeg,
        runtime,
        env: options.env,
        image: (payload, width, height) => {
          if (!stopped) publishImage(payload, width, height);
        },
        failure: fail,
      });
      keyframe();
    } else if (!images && jpeg) {
      const previous = jpeg;
      jpeg = undefined;
      await previous.stop();
      keyframe();
    }
    return images;
  };
  async function stop() {
    if (stopped) return;
    stopped = true;
    unwatch?.();
    const current = link;
    link = undefined;
    await restarting?.catch(() => {});
    const results = await Promise.allSettled([disconnect(current), jpeg?.stop()]);
    jpeg = undefined;
    terminated = true;
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Android capture cleanup failed");
  }
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (ms <= 0) resolve();
      else runtime.after(ms, resolve);
    });

  await connect();
  try {
    options.signal?.throwIfAborted();
    unwatch = platform.watchCaptureTransport(device, serial, (error) => fail(error));
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    streamId: options.streamId,
    multiTouch: true,
    get terminated() {
      return terminated;
    },
    stop,
    async configure(next) {
      if (stopped) throw new DeviceError("busy", "Device capture has stopped", "Start it again.");
      const wanted = profileFor(next, transport, 0);
      const current = link;
      settings = next;
      if (current?.frames) {
        // Encoded on the host: a new size restarts only the screenshot stream, and a new bit
        // rate reaches the encoder in place. The control server keeps running.
        if (wanted.maxSize !== current.profile.maxSize)
          current.frames.resize(wanted.maxSize || longEdge);
        if (wanted.bitrate !== current.profile.bitrate) current.frames.bitrate(wanted.bitrate);
        current.profile = { ...current.profile, maxSize: wanted.maxSize, bitrate: wanted.bitrate };
      } else if (
        current &&
        scrcpyRestartWorthIt(current.profile, wanted, runtime.now() - current.startedAt)
      ) {
        const previousJpeg = jpeg;
        jpeg = undefined;
        await previousJpeg?.stop();
        // The server's size, rate and bitrate are fixed per run: start a fresh one.
        restarting = (async () => {
          link = undefined;
          await disconnect(current);
          if (!stopped) await connect();
        })();
        try {
          await restarting;
        } catch (error) {
          fail(error);
          throw error;
        } finally {
          restarting = undefined;
        }
      }
      const images = await setImages(next.codec === "jpeg");
      return { codec: images ? "jpeg" : "h264" };
    },
    async keyframe() {
      keyframe();
    },
    async releaseInput() {
      const lifts = held.release();
      const current = link;
      const video = current && pictureSize(current);
      if (!current || !video?.width || !video.height) return;
      for (const input of lifts)
        try {
          for (const step of scrcpyInputPlan(
            input,
            displayFor(video.width, video.height),
            video,
            () => 0n,
          ))
            send(step.message, current);
        } catch {
          // A closed control socket, or a rotated screen, has already ended that touch.
        }
    },
    async input(input: DeviceInput, guard: () => void) {
      const current = link;
      if (!current || stopped) throw unavailable();
      const video = pictureSize(current);
      if (!video.width || !video.height)
        throw new DeviceError("busy", "The Android screen has not started yet", "Retry shortly.");
      // The clipboard numbers its own writes; the plan's sequence is not used.
      const plan = scrcpyInputPlan(input, displayFor(video.width, video.height), video, () => 0n);
      for (const step of plan) {
        await sleep(step.delayMs);
        guard();
        if (link !== current) throw new DeviceError("busy", "Android control restarted", "Retry.");
        const message = step.message;
        if (message.type === "setClipboard")
          await current.clipboard.write(message.text, message.paste);
        else send(message, current);
      }
      held.apply(input);
    },
    clipboard: {
      async read(guard) {
        const current = link;
        if (!current || stopped) throw unavailable();
        guard();
        return current.clipboard.read();
      },
      async write(text, guard) {
        const current = link;
        if (!current || stopped) throw unavailable();
        guard();
        await current.clipboard.write(text, false);
      },
    },
  };
}
