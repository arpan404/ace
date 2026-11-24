import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import { framePacket, type Frame } from "@ace/screen";
import type { ScreenStreamSettings } from "@ace/protocol";
import type { AppDevice as Device, DeviceInput } from "@ace/protocol/devices";
import { scrcpyVideoBackend } from "@ace/provider-kit/native-switches";
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
import { EarlyUnits } from "./scrcpy-early.ts";
import { HeldPointers, scrcpyInputPlan } from "./scrcpy-input.ts";
import {
  startScrcpyServer,
  startScrcpyTunnel,
  openScrcpySocket,
  scrcpyDidNotStart,
  scrcpyClosedDuringStartup,
  type ScrcpyConnection,
  type ScrcpyTunnel,
} from "./scrcpy-server.ts";
import { ScrcpyClipboard } from "./scrcpy-clipboard.ts";
import type { EmulatorGrpc } from "./emulator-discovery.ts";
import { startHostFrames, type HostFrames } from "./host-frames.ts";
import { DeviceVideoPaths, type DeviceMedia } from "./media-paths.ts";
import { IngestWriter } from "@ace/media/ingest-writer";
import type { ScrcpyGreeting } from "@ace/media/ingest-sources";
import { encodeProducerStamp } from "@ace/media/producer-stamp";
import type { MediaFrame } from "@ace/media/frame";

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
  /** The host-encoded picture's way through ace-media, while the daemon has one. */
  paths: DeviceVideoPaths | undefined;
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
/** How long ace-media gets for one scrcpy video handshake (D1): one startup deadline. */
const scrcpyMediaStartupMs = 10_000;

/** D1: whether ace-media reads a run's video socket itself. */
function mediaVideoFor(profile: ServerProfile): boolean {
  return profile.video !== false && scrcpyVideoBackend() === "native";
}

/**
 * Rejects when `signal` aborts: a handshake wait ends at once, not at its deadline.
 * The wait's own timer still fires later, harmlessly, once the race has settled.
 */
function abortRace<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  const cancel = Promise.withResolvers<never>();
  const onAbort = () =>
    cancel.reject(new DOMException("Device capture startup cancelled", "AbortError"));
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([promise, cancel.promise]).finally(() =>
    signal.removeEventListener("abort", onAbort),
  );
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
  /** ace-media (ADR 0147, phase 2): the host-encoded picture streams into it while routed. */
  media?: DeviceMedia;
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
  // ace-media (ADR 0147, phase 2, X2): the daemon keeps scrcpy's sockets and forwards each unit
  // unchanged to ace-media's ingest, the only way video reaches a viewer; egress brings it back.
  // One source for the capture's life, so a server restart (new viewer settings) doesn't
  // reopen it.
  let forward: IngestWriter | undefined;
  /** Moving to ace-media: units are dropped until the device's next keyframe, which is the
   * first unit forwarded (ace-media's egress drops anything before one). */
  let awaitingKey:
    | {
        writer: IngestWriter;
        started: (boundary: number | null) => void;
        failed: (error: Error) => void;
      }
    | undefined;
  let forwarded = 0;
  const media = options.media;
  let scrcpyPaths: DeviceVideoPaths | undefined;
  const closeScrcpyPaths = () => {
    scrcpyPaths?.close();
    scrcpyPaths = undefined;
  };
  /** One D1 handshake's waiters: greeted, then ready with the device name. */
  type ScrcpyHandshake = {
    greeted: PromiseWithResolvers<void>;
    ready: PromiseWithResolvers<string>;
    /** The dialled control socket, owned until it hands off to a link or fails. */
    control: Socket | undefined;
    /** True once control connected and the reader was told: that ack is this greeting's. */
    readyWaited: boolean;
    /** The reader that greeted (its open and generation): control's ack goes to it alone. */
    greetedOn: ScrcpyGreeting | undefined;
  };
  let handshake: ScrcpyHandshake | undefined;
  /** The path that greeted with no handshake armed yet (a reopen greets right after its
   * point). */
  let greetedEarly: ScrcpyGreeting | undefined;
  /** D1: the current reader ended (ingest passes on only the current generation's end). A
   * link is never installed over it, however its end and ready interleave. */
  let readerEnded = false;
  /** D1: the current reader's units that came before its link. */
  const early = new EarlyUnits();
  const pathsFor = () =>
    (scrcpyPaths ??= media
      ? new DeviceVideoPaths({
          media,
          source: `scrcpy:${options.streamId}`,
          kind: "scrcpy",
          origin: { kind: "scrcpy", host: "127.0.0.1", port: 0 },
          deviceId: device.id,
          emit: (unit) => publishVideo(unit),
          switch: async (address) => {
            if (address) {
              const writer: IngestWriter = new IngestWriter({
                socket: address.socket,
                token: address.token.slice(),
                onClosed: () => {
                  if (awaitingKey?.writer === writer) {
                    // Gone before the switch happened: nothing streams.
                    awaitingKey.failed(new Error("ace-media closed the ingest connection"));
                    awaitingKey = undefined;
                    return;
                  }
                  if (forward !== writer) return;
                  // ace-media went away: nothing streams until the source is opened again.
                  forward = undefined;
                  scrcpyPaths?.ingestClosed();
                  keyframe();
                },
                onKeyframe: () => keyframe(),
                after: runtime.after,
              });
              const keyed = Promise.withResolvers<number | null>();
              awaitingKey = { writer, started: keyed.resolve, failed: keyed.reject };
              keyframe();
              // A device that never answers still moves: from its next unit on.
              const cancel = runtime.after(keyframeRetryMs, () => {
                if (awaitingKey?.writer !== writer) return;
                awaitingKey = undefined;
                forward = writer;
                keyed.resolve(forwarded > 0 ? forwarded - 1 : null);
              });
              const boundary = await keyed.promise.finally(cancel);
              return { ingest: "on", boundary };
            }
            const previous = forward ?? awaitingKey?.writer;
            awaitingKey?.started(forwarded > 0 ? forwarded - 1 : null);
            awaitingKey = undefined;
            forward = undefined;
            // Every queued unit is written, then the connection ends cleanly: ace-media's end
            // marker follows the last one.
            previous?.finish();
            return { ingest: "off", boundary: null };
          },
          keyframe: () => keyframe(),
          schedule: (callback, ms) => runtime.after(ms, callback),
        })
      : undefined);
  /** A unit off scrcpy's video socket: to ace-media while it carries the capture, else to the viewer. */
  const forwardVideo = (unit: VideoUnit) => {
    const number = forwarded++;
    if (awaitingKey && unit.keyframe) {
      // The switch: everything before this went the daemon's way.
      forward = awaitingKey.writer;
      awaitingKey.started(number > 0 ? number - 1 : null);
      awaitingKey = undefined;
    }
    if (forward && !forward.closed) {
      // The frame depicts the native display at the encode's size, so the client's
      // width/scale is the display input uses.
      forward.write(scrcpyFrame(unit, displayFor(unit.width, unit.height), number));
      return;
    }
    // Opens the source in ace-media, which points the capture at its ingest once it has it. A
    // build without ace-media has no source and no ingest to reach: its viewers get the units.
    if (!pathsFor()) publishVideo(unit);
  };
  /** D1: the tunnel the current handshake runs on, for failure texts. */
  let activeTunnel: ScrcpyTunnel | undefined;
  const armHandshake = (): ScrcpyHandshake => {
    const attempt: ScrcpyHandshake = {
      greeted: Promise.withResolvers<void>(),
      ready: Promise.withResolvers<string>(),
      control: undefined,
      readyWaited: false,
      greetedOn: undefined,
    };
    // Rejections always have a handler: a racing close or stop must never go unhandled.
    attempt.greeted.promise.catch(() => {});
    attempt.ready.promise.catch(() => {});
    handshake = attempt;
    if (greetedEarly !== undefined) {
      attempt.greetedOn = greetedEarly;
      greetedEarly = undefined;
      attempt.greeted.resolve();
    }
    return attempt;
  };
  /** D1: close this run's tunnel and start a fresh server, tunnel and handshake under the
   * same source (a new profile, a media restart, or a video socket that ended). It is the
   * capture's one restart while it runs; a repoint queued meanwhile applies once it settles,
   * whether it worked or not (the last one wins). */
  const restart = (old: Link): Promise<void> => {
    const run = (async () => {
      link = undefined;
      await disconnect(old);
      if (!stopped) await connect();
    })();
    restarting = run;
    return run.finally(() => {
      if (restarting === run) restarting = undefined;
      if (repointQueued) void rehandshake().catch(() => {});
    });
  };
  /** D1: the backend the capture runs on, fixed at its first run and reconfigured when
   * it changes mid-capture, so paths are never reused across backends. */
  let pathsD1: boolean | undefined;
  /** D1: a repoint that arrived while unusable; the next usable moment applies it. */
  let repointQueued = false;
  /** D1: ace-media ended the source, mid-handshake or mid-stream. */
  const mediaClosed = (reason: string | undefined): void => {
    readerEnded = true;
    // A reader that ended has nothing left to install a link for, and admits nothing more.
    early.close();
    const pending = handshake;
    handshake = undefined;
    if (pending) {
      // Any end before ready fails this handshake, with today's text.
      const error =
        reason === "scrcpy-not-started"
          ? scrcpyDidNotStart(activeTunnel?.said() ?? "")
          : scrcpyClosedDuringStartup();
      pending.greeted.reject(error);
      pending.ready.reject(error);
      return;
    }
    const live = link;
    if (!live || stopped) return;
    // The stream ended under a running capture: today's restart rule, as for new viewer
    // settings. Unchanged settings are never worth a restart, so the capture ends.
    const wanted = profileFor(settings, transport, live.profile.scid);
    if (scrcpyRestartWorthIt(live.profile, wanted, runtime.now() - live.startedAt)) {
      void restart(live).catch((error: unknown) => fail(error));
      return;
    }
    lost(
      live,
      new DeviceError(
        "command_failed",
        "The Android screen stream ended",
        "Start the device view again.",
      ),
    );
  };
  /** D1: one unit of ace-media's reader on its link. */
  const showD1 = (live: Link, unit: VideoUnit) => {
    // The picture's size comes from the units themselves, not a handshake: track it for
    // input mapping, which refuses to run before the screen has started.
    const size = live.units.size;
    if (
      (size.width !== unit.width || size.height !== unit.height) &&
      unit.width > 0 &&
      unit.height > 0 &&
      unit.width <= 16384 &&
      unit.height <= 16384
    )
      live.units.push({ type: "session", width: unit.width, height: unit.height });
    live.streaming = true;
    publishVideo(unit);
  };
  const pathsForMedia = (
    port: number,
    deadlineMs: number | undefined,
  ): DeviceVideoPaths | undefined => {
    if (scrcpyPaths) return scrcpyPaths;
    if (!media) return undefined;
    const d1 = new DeviceVideoPaths({
      media,
      source: `scrcpy:${options.streamId}`,
      kind: "scrcpy",
      origin: { kind: "scrcpy", host: "127.0.0.1", port },
      deviceId: device.id,
      emit: (unit) => {
        if (stopped) return;
        // Before its link is in, a reader's units wait for it: never its first keyframe lost.
        if (link) showD1(link, unit);
        else early.hold(unit);
      },
      // ace-media is its own producer here: it reads the socket, so there is no ingest to
      // point at. A move cuts the old path, and the new one starts at a keyframe.
      switch: async (address) => ({ ingest: address ? "on" : "off", boundary: null, cut: true }),
      keyframe: () => keyframe(),
      schedule: (callback, ms) => runtime.after(ms, callback),
      scrcpy: {
        ...(deadlineMs === undefined ? {} : { deadlineMs }),
        greeted: (greeting) => {
          const attempt = handshake;
          if (!attempt) {
            greetedEarly = greeting;
            return;
          }
          if (attempt.readyWaited) {
            // Control was connected for the video socket that greeted first: that ack is
            // never reused for another one, so this handshake cannot finish.
            attempt.greeted.reject(scrcpyClosedDuringStartup());
            attempt.ready.reject(scrcpyClosedDuringStartup());
            return;
          }
          attempt.greetedOn ??= greeting;
          attempt.greeted.resolve();
        },
        ready: (deviceName) => {
          const attempt = handshake;
          if (!attempt) return;
          // Ready comes only from the newest path, so this handshake answers every repoint
          // queued before it.
          repointQueued = false;
          attempt.ready.resolve(deviceName);
        },
        closed: (reason) => mediaClosed(reason),
        repointed: () => {
          // Last one wins: queue while a restart or handshake runs, drain after.
          repointQueued = true;
          void rehandshake().catch(() => {});
        },
      },
    });
    scrcpyPaths = d1;
    return d1;
  };
  /** D1: one video handshake under the single startup deadline. The attempt owns the
   * control socket from its connect: every failure path destroys it unless it handed
   * off to a link. */
  const shakeHands = async (
    tunnel: ScrcpyTunnel,
    port: number,
    paths: DeviceVideoPaths,
    deadline: number,
  ): Promise<{ control: Socket; deviceName: string }> => {
    const remaining = () => Math.max(1, deadline - runtime.now());
    const failAt = (error: () => unknown): Promise<never> =>
      new Promise((_, reject) => {
        runtime.after(remaining(), () => reject(error()));
      });
    // A server exit fails the start at once, with today's text, whether the exit promise
    // resolves or rejects. Before its greeting that is "did not start"; after it, the
    // server closed during startup, as the switch-off path names the same two cases.
    const serverExit = (error: () => unknown): Promise<never> =>
      tunnel.exited.then(
        () => {
          throw error();
        },
        () => {
          throw error();
        },
      );
    const attempt = armHandshake();
    // A close before ready ends the handshake the way a reset would: today's text.
    const onHandshakeClose = () => {
      if (handshake === attempt) {
        attempt.greeted.reject(scrcpyClosedDuringStartup());
        attempt.ready.reject(scrcpyClosedDuringStartup());
      }
    };
    // A connect that loses the race destroys its socket on arrival instead of abandoning it.
    let connectDone = false;
    try {
      activeTunnel = tunnel;
      options.signal?.throwIfAborted();
      // The dummy byte, before anything else: the device name follows only once every
      // socket is connected.
      await abortRace(
        Promise.race([
          attempt.greeted.promise,
          serverExit(() => scrcpyDidNotStart(tunnel.said())),
          failAt(() => scrcpyDidNotStart(tunnel.said())),
        ]),
        options.signal,
      );
      options.signal?.throwIfAborted();
      // A reader that ends while control is still dialling rejects the readiness waiter: the
      // dial race settles on that rejection instead of waiting for the deadline. Built here,
      // after the greeting, so a greeting failure never leaves it unhandled.
      const readyEnded = attempt.ready.promise.then(
        () => new Promise<never>(() => {}),
        (error) => {
          throw error;
        },
      );
      const socket = await abortRace(
        Promise.race([
          openScrcpySocket(port, runtime, deadline, options.signal).then((connected) => {
            if (connectDone) {
              connected?.destroy();
              return new Promise<Socket>(() => {});
            }
            if (connected === undefined) throw scrcpyClosedDuringStartup();
            // Owned before anything can throw: the finally below destroys it on any failure.
            attempt.control = connected;
            if (options.signal?.aborted) {
              attempt.control = undefined;
              connected.destroy();
              options.signal.throwIfAborted();
            }
            return connected;
          }),
          serverExit(() => scrcpyClosedDuringStartup()),
          failAt(() => scrcpyClosedDuringStartup()),
          readyEnded,
        ]),
        options.signal,
      );
      if (attempt.control !== socket || socket.destroyed) throw scrcpyClosedDuringStartup();
      socket.once("close", onHandshakeClose);
      // The ack goes to the path that greeted, never to one that replaced it since.
      if (attempt.greetedOn !== undefined) paths.controlConnected(attempt.greetedOn);
      attempt.readyWaited = true;
      options.signal?.throwIfAborted();
      const deviceName = await abortRace(
        Promise.race([
          attempt.ready.promise,
          serverExit(() => scrcpyClosedDuringStartup()),
          failAt(() => scrcpyClosedDuringStartup()),
        ]),
        options.signal,
      );
      socket.off("close", onHandshakeClose);
      const control = attempt.control;
      attempt.control = undefined;
      if (!control || control.destroyed) throw scrcpyClosedDuringStartup();
      return { control, deviceName };
    } finally {
      connectDone = true;
      if (handshake === attempt) handshake = undefined;
      const owned = attempt.control;
      attempt.control = undefined;
      owned?.destroy();
    }
  };
  /** D1: ace-media restarted under a live capture: only a real server restart recovers —
   * the pinned server establishes one video/control pair per start, so the same tunnel
   * cannot greet a replacement video socket. Restart like a profile change would,
   * queueing repoints that arrive mid-restart and applying the latest after. */
  let rehandshaking = false;
  const rehandshake = async (): Promise<void> => {
    if (rehandshaking) return;
    rehandshaking = true;
    try {
      for (;;) {
        if (!repointQueued) return;
        const live = link;
        // Unusable now: the flag stays set for the next usable moment.
        if (!live || stopped || handshake || restarting) return;
        repointQueued = false;
        await restart(live);
      }
    } catch (error) {
      fail(error);
    } finally {
      rehandshaking = false;
    }
  };
  /** Starts a server run and makes it the current link before any of its video is read. */
  const connect = async (): Promise<void> => {
    let current: Link | undefined;
    let paths: DeviceVideoPaths | undefined;
    const box = (maxSize: number) => maxSize || longEdge;
    const wanted = profileFor(settings, transport, scid());
    // Only ace-media carries a host-encoded picture (`emulator-frames`); without it, scrcpy's
    // video is the one path there is, and the capture publishes it itself.
    const frames =
      options.host && media
        ? await startHostFrames({
            ...options.host,
            display: { width: shortEdge, height: longEdge },
            box: box(wanted.maxSize),
            bitrate: wanted.bitrate,
            runtime,
            env: options.env,
            failed: (error) => {
              if (current) lost(current, error);
            },
            ingestClosed: () => paths?.ingestClosed(),
          }).catch(() => undefined)
        : undefined;
    if (frames && media)
      paths = new DeviceVideoPaths({
        media,
        source: `emulator:${options.streamId}`,
        kind: "emulator-frames",
        origin: {
          kind: "emulator-frames",
          path: frames.file,
          width: shortEdge,
          height: longEdge,
          stride: shortEdge * 4,
        },
        deviceId: device.id,
        emit: (unit) => {
          if (!current) return;
          current.streaming = true;
          if (!stopped && link === current) publishVideo(unit);
        },
        switch: (address) =>
          frames.ingest(
            address
              ? { socket: address.socket, token: Buffer.from(address.token).toString("base64") }
              : undefined,
          ),
        keyframe: () => frames.keyframe(),
        schedule: (callback, ms) => runtime.after(ms, callback),
      });
    const profile: ServerProfile = { ...wanted, video: frames === undefined };
    // D1: only when both sides advertise it (the switch on the daemon, scrcpy-video on
    // ace-media). The choice is fixed at the capture's first run; a change mid-capture
    // retires the paths configured for the other backend. Otherwise the daemon reads
    // both sockets itself and forwards, as today.
    const wantD1 = mediaVideoFor(profile) && media?.speaks?.("scrcpy-video") === true;
    if (pathsD1 !== undefined && pathsD1 !== wantD1) {
      scrcpyPaths?.close();
      scrcpyPaths = undefined;
      repointQueued = false;
      greetedEarly = undefined;
      early.close();
    }
    pathsD1 = wantD1;
    // One source for the picture, whichever carries it. With the host encoder it is
    // `emulator-frames`, so a scrcpy source opened for an earlier run (one that streamed its
    // video) is closed, never left for a view to bind. Without it, scrcpy's video is the one
    // path there is: the daemon's own forward needs its source before the first keyframe
    // (D1's source opens below, once the tunnel's port is known).
    if (frames) closeScrcpyPaths();
    else if (!wantD1) pathsFor();
    if (wantD1 && media) {
      // D1: ace-media reads the video socket itself. The daemon keeps the server, the
      // forward and control; video arrives on egress once the handshake finishes.
      const tunnel = await startScrcpyTunnel({
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
        // A handshake that never started still never leaves a reader's units held.
        early.close();
        paths?.close();
        await frames?.stop();
        throw error;
      });
      // A restart reuses the source: tell ace-media's reader to dial the new tunnel,
      // ordered before the handshake that waits for its greeting.
      const fresh = !scrcpyPaths;
      const source = pathsForMedia(tunnel.port, scrcpyMediaStartupMs);
      if (!source) {
        await tunnel.close();
        early.close();
        throw new DeviceError(
          "command_failed",
          "The Android live view needs ace-media",
          "Restart ace to bring ace-media back.",
        );
      }
      // A new reader: nothing of an earlier one (a greeting, an end, its units) counts.
      greetedEarly = undefined;
      readerEnded = false;
      early.clear();
      if (!fresh) source.dial("127.0.0.1", tunnel.port);
      const deadline = runtime.now() + scrcpyMediaStartupMs;
      try {
        const { control, deviceName } = await shakeHands(tunnel, tunnel.port, source, deadline);
        let closingTunnel: Promise<void> | undefined;
        const started: Link = {
          connection: {
            video: undefined,
            control,
            initialVideo: Buffer.alloc(0),
            initialControl: Buffer.alloc(0),
            deviceName,
            exited: tunnel.exited,
            close: () =>
              (closingTunnel ??= (async () => {
                control.destroy();
                await tunnel.close();
              })()),
          },
          profile,
          frames,
          paths,
          startedAt: runtime.now(),
          clipboard: new ScrcpyClipboard({
            send: (message) => send(message, started),
            after: runtime.after,
          }),
          streaming: false,
          // The picture's size comes from the units, not a handshake: the paths track it.
          units: new ScrcpyVideoUnits(
            () => {},
            () => {},
          ),
        };
        current = started;
        const messages = new DeviceMessageReader((message) => started.clipboard.received(message));
        control.on("data", (chunk: Buffer) => {
          try {
            messages.push(chunk);
          } catch (error) {
            lost(started, error);
          }
        });
        control.on("error", () => {});
        control.once("close", () =>
          lost(
            started,
            new DeviceError(
              "command_failed",
              "The Android screen stream ended",
              "Start the device view again.",
            ),
          ),
        );
        // `exited` reports the tunnel's exit and does not reject.
        void tunnel.exited
          .then(() =>
            lost(
              started,
              new DeviceError(
                "command_failed",
                "scrcpy-server stopped on the device",
                "Start the device view again.",
              ),
            ),
          )
          .catch(() => {});
        if (stopped) {
          await disconnect(started);
          return;
        }
        // Its reader ended before the link was in (its end and ready came together): no link
        // over a reader that is gone.
        if (readerEnded) {
          early.close();
          await disconnect(started);
          throw scrcpyClosedDuringStartup();
        }
        link = started;
        // What the reader sent before its link, in order, from its first keyframe.
        const before = early.take();
        for (const unit of before.units) showD1(started, unit);
        if (before.lost) {
          started.streaming = true;
          keyframe();
        }
        control.resume();
        // A repoint that arrived mid-handshake applies after it, not during it.
        if (repointQueued) void rehandshake().catch(() => {});
        return;
      } catch (error) {
        // A handshake that failed (deadline, close, server exit) keeps nothing for a link.
        early.close();
        await tunnel.close();
        throw error;
      }
    }
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
      paths?.close();
      await frames?.stop();
      throw error;
    });
    const started: Link = {
      connection,
      profile,
      frames,
      paths,
      startedAt: runtime.now(),
      clipboard: new ScrcpyClipboard({
        send: (message) => send(message, started),
        after: runtime.after,
      }),
      streaming: false,
      units: new ScrcpyVideoUnits(
        (unit) => {
          started.streaming = true;
          if (!stopped && link === started) forwardVideo(unit);
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
    // `exited` reports the connection's exit and does not reject.
    void connection.exited
      .then(() =>
        lost(
          started,
          new DeviceError(
            "command_failed",
            "scrcpy-server stopped on the device",
            "Start the device view again.",
          ),
        ),
      )
      .catch(() => {});
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
    current.paths?.close();
    await Promise.all([current.frames?.stop(), current.connection.close()]);
  };
  async function stop() {
    if (stopped) return;
    stopped = true;
    unwatch?.();
    // A handshake still waiting ends now: its waits would otherwise hang until the deadline.
    const waiting = handshake;
    handshake = undefined;
    greetedEarly = undefined;
    early.close();
    if (waiting) {
      const error = new DOMException("Device capture stopped", "AbortError");
      waiting.greeted.reject(error);
      waiting.ready.reject(error);
    }
    const current = link;
    link = undefined;
    await restarting?.catch(() => {});
    forward?.close();
    // Closing a writer skips its onClosed: a move still waiting for the device's keyframe is
    // told here, so it never hangs.
    const pending = awaitingKey;
    awaitingKey = undefined;
    pending?.writer.close();
    pending?.failed(new Error("Device capture stopped"));
    forward = undefined;
    closeScrcpyPaths();
    const results = await Promise.allSettled([disconnect(current)]);
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

  // The source opens in ace-media before the device sends its first keyframe, so that one
  // is the first unit forwarded (or the scrcpy server does, with no source at all; with the
  // switch on, the D1 handshake opens it once the tunnel's port is known).
  try {
    await connect();
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
        // The server's size, rate and bitrate are fixed per run: start a fresh one.
        try {
          await restart(current);
        } catch (error) {
          fail(error);
          throw error;
        }
      }
      // The capture is always H.264 (X1): agents' stills come from the device itself.
      return { codec: "h264" };
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
      async read(guard, owner) {
        const current = link;
        if (!current || stopped) throw unavailable();
        guard();
        return current.clipboard.read(owner);
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

/** A scrcpy unit as the MediaFrame the daemon forwards: the producer stamp keeps its sequence. */
export function scrcpyFrame(
  unit: VideoUnit,
  display: { width: number; height: number },
  sequence: number,
): MediaFrame {
  return {
    kind: 1,
    flags: unit.keyframe ? 1 : 0,
    ageUs: 0,
    width: unit.width,
    height: unit.height,
    displayWidth: display.width,
    displayHeight: display.height,
    scale: 1000,
    rotation: 0,
    codec: 1,
    encode: 0,
    epoch: 0,
    codecString: unit.keyframe ? unit.videoCodec : "",
    description: new Uint8Array(0),
    extension: encodeProducerStamp({ sequence, timestamp: Number(unit.pts) / 1000, scale: 1 }),
    payload: unit.payload,
  };
}
