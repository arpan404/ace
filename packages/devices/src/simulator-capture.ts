import { z } from "zod";
import { framePacket, type Frame } from "@ace/screen";
import type { ScreenLegacyFrameHeader, ScreenStreamSettings } from "@ace/protocol";
import type { AppDevice } from "@ace/protocol/devices";
import type { DeviceCapture } from "./capture.ts";
import type { DeviceShot } from "./one-off-screenshot.ts";
import type { DeviceRuntime } from "./runtime.ts";
import { SimulatorInput } from "./simulator-input.ts";
import { SimulatorJpeg } from "./simulator-jpeg.ts";
import { DeviceVideoPaths, type DeviceMedia } from "./media-paths.ts";
import type { VideoUnit } from "./scrcpy-video.ts";
import { simulatorEncodeSpec, simulatorNeedsTranscode } from "./simulator-transcode.ts";
import { simulatorUI } from "./simulator-ui.ts";
import { SimulatorSourceRate } from "./simulator-source-rate.ts";
import { nativeId } from "./commands.ts";
import { knownOrientation, simulatorRotation } from "./simulator-rotation.ts";
import { DeviceError } from "./sdk.ts";
import { startSimulatorDigitizer, type SimulatorDigitizer } from "./simulator-digitizer.ts";
import { touchTarget, type SimulatorScreen } from "./simulator-screens.ts";

const Endpoint = z.object({
  device: z.string().uuid(),
  port: z.number().int().min(1).max(65535),
  streamUrl: z.string().max(4096),
  wsUrl: z.string().max(4096),
});
/**
 * An agent's still from ace-media: inside the frame packet's bounds (a portrait phone fitted to
 * 2160 high), which ace-media scales to, never the daemon. A late one gives way to `simctl`.
 */
const agentStill = {
  maxWidth: 1920,
  maxHeight: 2160,
  maxPixels: 1920 * 2160,
  quality: 80,
  deadlineMs: 1_500,
};

/** serve-sim announces the screen's size and orientation on its control socket (tag 130). */
const ScreenConfig = z.object({
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
  orientation: z.string().max(64).optional(),
});
function localUrl(value: string, port: number, protocol: string) {
  const url = new URL(value);
  if (
    url.protocol !== protocol ||
    url.hostname !== "127.0.0.1" ||
    Number(url.port) !== port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Simulator helper returned a non-local endpoint");
  return url;
}
/** The device's other serve-sim routes sit beside its announced MJPEG stream. */
function sibling(stream: URL, name: string): URL {
  if (!stream.pathname.endsWith("/stream.mjpeg") || stream.search)
    throw new Error("Simulator helper returned an unexpected stream route");
  const url = new URL(stream.href);
  url.pathname = stream.pathname.slice(0, -"stream.mjpeg".length) + name;
  return url;
}

/**
 * The public serve-sim CLI owns the native framebuffer, HID and accessibility connection for
 * this UDID. Live views get serve-sim's H.264 through ace-media, which reads the stream itself:
 * as-is, unless a viewer can't carry it (its link is below serve-sim's measured busy rate, at
 * least 6 Mbit/s, or its panel is smaller than the native picture), when ace-media re-encodes
 * it on VideoToolbox at the size and rate asked for. Without ace-media there is no live view.
 * serve-sim's MJPEG, resized, only feeds agents' stills and recordings while nobody watches.
 */
export async function simulatorCapture(options: {
  command: string;
  /** Arguments before serve-sim's own: ace's copy runs as `node <script>`. */
  commandArgs?: readonly string[];
  device: AppDevice;
  streamId: string;
  fps: number;
  env: NodeJS.ProcessEnv;
  runtime: DeviceRuntime;
  signal?: AbortSignal;
  publish(frame: Frame): void;
  failure(error: unknown): void;
  /** The screen helper, to touch the Simulator through Xcode's own input service. */
  digitizer?: string;
  /** The Simulator's built-in screens, so a touch reaches the one in the picture. */
  screens?: () => Promise<readonly SimulatorScreen[]>;
  /** ace-media (ADR 0147, phase 2): it reads serve-sim's stream itself while routed. */
  media?: DeviceMedia;
}): Promise<DeviceCapture> {
  const { runtime } = options;
  const fetcher = runtime.fetch ?? fetch;
  const controller = new AbortController();
  if (options.signal?.aborted) controller.abort();
  controller.signal.throwIfAborted();
  // Cancelling stops everything this capture started. The stream request and the helper don't
  // watch the controller, so a startup still waiting on serve-sim would otherwise never unwind.
  const abort = () => void stop().catch(() => {});
  options.signal?.addEventListener("abort", abort, { once: true });
  const child = runtime.spawn({
    command: options.command,
    args: [...(options.commandArgs ?? []), "--no-preview", "--quiet", nativeId(options.device)],
    env: options.env,
    name: "simulator-framebuffer",
  });
  let stopped = false,
    announced = false,
    sequence = 0;
  const screen = { width: 0, height: 0, orientation: "portrait" };
  let mode: "jpeg" | "h264" = "jpeg";
  let terminated = false;
  let input: SimulatorInput | undefined;
  let jpeg: SimulatorJpeg | undefined;
  /** serve-sim's video through ace-media, only while viewers want video (E3b). */
  let paths: DeviceVideoPaths | undefined;
  /** Touches through Xcode's input service, started beside serve-sim's control socket. */
  let touching: Promise<SimulatorDigitizer | undefined> | undefined;
  let screens: readonly SimulatorScreen[] = [];
  /** The lit screen's size, which ace asked serve-sim to stream (a device with several). */
  let lit: { width: number; height: number } | undefined;
  let reading: Promise<void> | undefined;
  /** Reads the screens again (a fold lights another one); one read at a time. */
  const readScreens = (read: () => Promise<readonly SimulatorScreen[]>) =>
    (reading ??= read()
      .then((found) => {
        screens = found;
      })
      .catch(() => {})
      .finally(() => {
        reading = undefined;
      }));
  // Read while serve-sim starts: the first touch must already know which screen it is on.
  const screensRead = options.screens ? readScreens(options.screens) : undefined;
  /** serve-sim's native picture, from its stream's parameter sets. */
  let native: { width: number; height: number } | undefined;
  let socket: WebSocket | undefined;
  let closing: Promise<void> | undefined;
  const stop = () =>
    (closing ??= (async () => {
      stopped = true;
      controller.abort();
      options.signal?.removeEventListener("abort", abort);
      const released = input?.release();
      const results = await Promise.allSettled([
        Promise.resolve(released).finally(() => socket?.close()),
        jpeg?.stop(),
        Promise.resolve(paths?.close()),
        touching?.then((digitizer) => digitizer?.stop()),
        child.stop({ graceMs: 1500 }),
      ]);
      terminated = true;
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Simulator capture cleanup failed");
    })());
  const failed = (error: unknown) => {
    if (stopped) return;
    options.failure(error);
    void stop().catch(() => {});
  };
  // Pictures stay in the portrait framebuffer when the device turns; viewers turn them upright.
  const publish = (frame: ScreenLegacyFrameHeader, payload: Buffer) => {
    const header: Frame["header"] = { ...frame, rotation: simulatorRotation(screen.orientation) };
    const packet = framePacket(header, payload);
    options.publish({ header, payload: packet.subarray(packet.length - payload.length), packet });
  };
  // A reused external serve-sim server exits its CLI normally. Its lifetime remains external.
  // `exited` reports the helper's exit and does not reject.
  void child.exited
    .then((exit) => {
      if (!stopped && (!announced || exit.code !== 0))
        failed(new Error("Simulator framebuffer helper stopped"));
    })
    .catch(() => {});
  const endpoint = Promise.withResolvers<z.infer<typeof Endpoint>>();
  void endpoint.promise.catch(() => {});
  const cancel = runtime.after(10000, () => {
    endpoint.reject(new Error("Simulator helper startup timed out"));
    controller.abort();
  });
  const onAbort = () =>
    endpoint.reject(new DOMException("Simulator capture cancelled", "AbortError"));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  let output = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    if (announced || stopped) return;
    try {
      if (output.length + chunk.length > 8192)
        throw new Error("Simulator endpoint metadata exceeds limit");
      output = Buffer.concat([output, chunk]);
      // serve-sim may print a notice first (a busy port it cleared); the endpoint is the first
      // line that is JSON.
      let line: unknown;
      for (let end = output.indexOf(10); end >= 0 && line === undefined; end = output.indexOf(10)) {
        const text = output.subarray(0, end).toString("utf8");
        output = output.subarray(end + 1);
        try {
          line = JSON.parse(text);
        } catch {
          // Not the endpoint: keep reading.
        }
      }
      if (line === undefined) return;
      const value = Endpoint.parse(line);
      if (value.device.toLowerCase() !== nativeId(options.device).toLowerCase())
        throw new Error("Simulator helper identity mismatch");
      localUrl(value.streamUrl, value.port, "http:");
      localUrl(value.wsUrl, value.port, "ws:");
      announced = true;
      output = Buffer.alloc(0);
      endpoint.resolve(value);
    } catch (error) {
      endpoint.reject(error);
    }
  });
  // Drain native diagnostic output without retaining potentially unlimited vendor text.
  child.stderr.on("data", () => {});
  const startJpeg = async (url: URL) => {
    const source = new SimulatorJpeg({
      url,
      fps: options.fps,
      fetch: fetcher,
      now: runtime.now,
      after: runtime.after,
      failure: failed,
      source(width, height) {
        if (!screen.width) Object.assign(screen, { width, height });
      },
      publish(image, scale) {
        if (stopped || mode !== "jpeg" || jpeg !== source) return;
        publish(
          {
            version: 1,
            sessionId: options.streamId,
            sequence: sequence++,
            timestamp: runtime.now(),
            width: image.width,
            height: image.height,
            scale,
            codec: "jpeg",
            bytes: image.bytes.length,
          },
          image.bytes,
        );
      },
    });
    jpeg = source;
    await source.start();
    return source;
  };
  try {
    const value = await endpoint.promise;
    const toucher = options.digitizer;
    if (toucher) {
      touching = startSimulatorDigitizer({
        helper: toucher,
        udid: value.device,
        runtime,
        env: options.env,
        target: () => touchTarget(screens, native ?? lit),
      }).catch(() => undefined);
    }
    cancel();
    controller.signal.removeEventListener("abort", onAbort);
    controller.signal.throwIfAborted();
    const streamUrl = localUrl(value.streamUrl, value.port, "http:");
    const avccUrl = sibling(streamUrl, "stream.avcc");
    const axUrl = sibling(streamUrl, "ax");
    await startJpeg(streamUrl);
    socket = (runtime.socket ?? ((endpointUrl) => new WebSocket(endpointUrl)))(
      localUrl(value.wsUrl, value.port, "ws:").href,
    );
    socket.binaryType = "arraybuffer";
    const connected = Promise.withResolvers<void>();
    const sized = Promise.withResolvers<void>();
    const connectTimeout = runtime.after(5000, () =>
      connected.reject(new Error("Simulator control connection timed out")),
    );
    const socketAbort = () =>
      connected.reject(new DOMException("Simulator capture cancelled", "AbortError"));
    controller.signal.addEventListener("abort", socketAbort, { once: true });
    socket.addEventListener("open", () => connected.resolve(), { once: true });
    socket.addEventListener("error", () => {
      connected.reject(new Error("Simulator control connection failed"));
      failed(new Error("Simulator control connection failed"));
    });
    socket.addEventListener("close", () => failed(new Error("Simulator control connection ended")));
    socket.addEventListener("message", (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > 4096) return;
      const bytes = Buffer.from(event.data);
      if (bytes[0] !== 130) return;
      try {
        const config = ScreenConfig.safeParse(JSON.parse(bytes.subarray(1).toString("utf8")));
        if (config.success) {
          const before = simulatorRotation(screen.orientation);
          // Once the picture's own size is known, it stands: serve-sim can keep naming the
          // screen it attached to (an iPhone Duo's cover) while it streams another.
          Object.assign(
            screen,
            (native ?? lit)
              ? { orientation: config.data.orientation ?? screen.orientation }
              : config.data,
          );
          // readScreens swallows a failed read; the next size report asks again.
          if (options.screens) void readScreens(options.screens).catch(() => {});
          sized.resolve();
          // A portrait-only app shows no new picture when the device turns; resend one so
          // viewers learn the new rotation anyway.
          if (input && simulatorRotation(screen.orientation) !== before)
            if (mode === "h264") paths?.keyframe();
            else void jpeg?.replay().catch(() => {});
        }
      } catch {
        // Unknown or malformed control messages are ignored; input keeps the last size.
      }
    });
    try {
      await connected.promise;
      // serve-sim names the screen's size on attach; input and accessibility map against it.
      // Without it the first JPEG's native size stands in.
      const unsized = runtime.after(1000, () => sized.resolve());
      await sized.promise.finally(unsized);
    } finally {
      connectTimeout();
      controller.signal.removeEventListener("abort", socketAbort);
    }
    controller.signal.throwIfAborted();
    const [digitizer] = await Promise.all([
      touching,
      new Promise<void>((resolve) => {
        const giveUp = runtime.after(3000, resolve);
        // `screensRead` swallows a failed read; only the give-up timer is left to clear.
        void Promise.resolve(screensRead)
          .finally(() => {
            giveUp();
            resolve();
          })
          .catch(() => {});
      }),
    ]);
    controller.signal.throwIfAborted();
    // serve-sim starts on a device's smallest screen and moves only when it sees the device
    // fold, so an iPhone Duo opened earlier would stream its dark cover. Ask for the lit one.
    const shown = screens.length > 1 ? screens.find((candidate) => candidate.active) : undefined;
    if (shown && socket.readyState === WebSocket.OPEN) {
      lit = { width: shown.width, height: shown.height };
      Object.assign(screen, lit);
      socket.send(Buffer.concat([Buffer.from([13]), Buffer.from(JSON.stringify(lit))]));
    }
    input = new SimulatorInput({
      runtime,
      command: options.command,
      commandArgs: options.commandArgs ?? [],
      device: value.device,
      env: options.env,
      dimensions: () => screen,
      orientation: () => screen.orientation,
      send(tag, payload, cleanup) {
        if (socket?.readyState !== WebSocket.OPEN)
          throw new Error("Simulator control connection closed");
        if (!cleanup && socket.bufferedAmount > 65536)
          throw new Error("Simulator input backlog exceeded limit");
        socket.send(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))]));
      },
      ...(digitizer ? { touch: (message) => digitizer.touch(message) } : {}),
    });
    const nativeInput = input;
    // serve-sim announces the orientation it last asked for, not the one the Simulator is in: a
    // fresh serve-sim says portrait even when an earlier session (or Simulator's own menu) left
    // the device turned, and viewers would show a sideways picture in an upright frame. Turning
    // the device to what is announced makes the picture and its rotation agree from the start.
    // A device with several screens is left alone: an iPhone Duo's inner screen stays landscape
    // whatever it is asked, and serve-sim follows its orientation itself.
    if (screens.length < 2)
      socket.send(
        Buffer.concat([
          Buffer.from([7]),
          Buffer.from(JSON.stringify({ orientation: knownOrientation(screen.orientation) })),
        ]),
      );
    /** One H.264 unit back from ace-media: serve-sim's own, or re-encoded for the viewer. */
    const deliverH264 = (unit: VideoUnit) => {
      if (stopped || !video) return;
      // Re-encoded by ace-media at the viewer's size: published as such, leaving serve-sim's
      // own picture (input mapping, its measured rate) alone.
      if (unit.encode) {
        publish(
          {
            version: 1,
            sessionId: options.streamId,
            sequence: sequence++,
            timestamp: runtime.now(),
            width: unit.width,
            height: unit.height,
            scale: native ? unit.width / native.width : 1,
            codec: "h264",
            keyframe: unit.keyframe,
            ...(unit.keyframe ? { videoCodec: unit.videoCodec } : {}),
            bytes: unit.payload.length,
          },
          unit.payload,
        );
        return;
      }
      // The first IDR is the switch: later JPEG frames are dropped from here on.
      mode = "h264";
      Object.assign(screen, { width: unit.width, height: unit.height });
      native = { width: unit.width, height: unit.height };
      // A busier source than the viewer was judged against may need re-encoding now.
      if (
        rate.record(runtime.now(), unit.payload.length) &&
        viewer &&
        needsTranscode(viewer) !== mediaTranscoding
      )
        void follow(viewer).catch(() => {});
      publish(
        {
          version: 1,
          sessionId: options.streamId,
          sequence: sequence++,
          timestamp: runtime.now(),
          width: unit.width,
          height: unit.height,
          scale: 1,
          codec: "h264",
          keyframe: unit.keyframe,
          ...(unit.keyframe ? { videoCodec: unit.videoCodec } : {}),
          bytes: unit.payload.length,
        },
        unit.payload,
      );
    };
    /** Viewers want video (not stills): serve-sim's units are theirs. */
    let video = false;
    /** ace-media reads serve-sim's stream itself while the route says so (E3b). */
    let fromMedia = false;
    /** ace-media re-encodes serve-sim's stream for the viewer (`source.encodes`). */
    let mediaTranscoding = false;
    const media = options.media;
    const routed = () =>
      (paths ??= media
        ? new DeviceVideoPaths({
            media,
            source: `simulator:${options.streamId}`,
            kind: "simulator",
            origin: { kind: "simulator", streamUrl: avccUrl.href, stillUrl: streamUrl.href },
            deviceId: options.device.id,
            emit: (unit) => deliverH264(unit),
            // ace-media is its own producer here: it reads serve-sim, or (gone) nothing does.
            switch: async (address) => {
              fromMedia = address !== undefined;
              mediaTranscoding = false;
              if (viewer) void follow(viewer).catch(() => {});
              return { ingest: address ? "on" : "off", boundary: null, cut: true };
            },
            keyframe: () => void paths?.keyframe(),
            schedule: (callback, ms) => runtime.after(ms, callback),
          })
        : undefined);
    const toH264 = async (): Promise<"h264"> => {
      // A live view is video through ace-media or nothing: say so rather than hand it JPEG.
      if (!routed())
        throw new DeviceError(
          "command_failed",
          "Live video needs ace-media, which isn't available on this computer",
          "Agents can still see and drive the Simulator. Restart ace to bring ace-media back.",
        );
      video = true;
      const previous = jpeg;
      jpeg = undefined;
      await previous?.stop();
      return "h264";
    };
    /** serve-sim's busiest recent rate, measured, so viewers are judged against what it sends. */
    const rate = new SimulatorSourceRate();
    /** The H.264 viewers' settings, while serve-sim's stream feeds them. */
    let viewer: ScreenStreamSettings | undefined;
    let following: Promise<void> = Promise.resolve();
    /** One decision at a time, in the order asked. */
    const follow = (settings: ScreenStreamSettings) =>
      (following = following.then(() => followViewer(settings)).catch(() => {}));
    const needsTranscode = (settings: ScreenStreamSettings) =>
      simulatorNeedsTranscode({
        transcoding: mediaTranscoding,
        bitrate: settings.bitrate,
        box: settings,
        native,
        source: rate.peak(runtime.now()),
      });
    /**
     * serve-sim's stream as it is while the viewers can carry it; re-encoded by ace-media at
     * their size and rate when they can't. Each switch starts from a keyframe.
     */
    const followViewer = async (settings: ScreenStreamSettings) => {
      if (stopped || viewer !== settings || !fromMedia || !paths) return;
      const need = needsTranscode(settings);
      if (need && native) paths.encodes([simulatorEncodeSpec(native, settings)]);
      else if (!need && mediaTranscoding) paths.encodes([]);
      mediaTranscoding = need && native !== undefined;
    };
    const toJpeg = async (settings: ScreenStreamSettings): Promise<"jpeg"> => {
      const source = jpeg ?? (await startJpeg(streamUrl));
      video = false;
      mediaTranscoding = false;
      paths?.close();
      paths = undefined;
      fromMedia = false;
      mode = "jpeg";
      await source.configure(settings);
      return "jpeg";
    };
    return {
      streamId: options.streamId,
      // serve-sim takes a two-finger touch, so pointer ids 0 and 1 both reach it.
      multiTouch: true,
      get terminated() {
        return terminated;
      },
      async stop() {
        await stop();
      },
      async configure(settings) {
        controller.signal.throwIfAborted();
        if (settings.codec !== "h264") {
          viewer = undefined;
          await following;
          return { codec: await toJpeg(settings) };
        }
        const codec = await toH264();
        viewer = settings;
        await follow(settings);
        return { codec };
      },
      still: async () => {
        controller.signal.throwIfAborted();
        if (mode === "jpeg") await jpeg?.replay();
      },
      // ace-media has serve-sim's stream while a view watches: the still is its, scaled there.
      mediaStill: async () => {
        controller.signal.throwIfAborted();
        if (!paths || !fromMedia) return undefined;
        const size = native;
        return paths.still<DeviceShot | undefined>(
          agentStill,
          () => Promise.resolve(undefined),
          (made) => ({
            payload: Buffer.from(made.jpeg),
            width: made.width,
            height: made.height,
            scale: size ? made.width / size.width : 1,
          }),
        );
      },
      keyframe: async () => {
        controller.signal.throwIfAborted();
        if (mode === "h264" && paths?.keyframe()) return;
        if (mode === "jpeg") await jpeg?.replay();
      },
      releaseInput: () => nativeInput.release(),
      async input(raw, guard) {
        controller.signal.throwIfAborted();
        await nativeInput.input(raw, guard);
      },
      ui: simulatorUI({
        url: axUrl,
        fetch: fetcher,
        signal: controller.signal,
        after: runtime.after,
        screen: () => screen,
        input: (raw, guard) => nativeInput.input(raw, guard),
      }),
    };
  } catch (error) {
    cancel();
    controller.signal.removeEventListener("abort", onAbort);
    await stop();
    throw error;
  }
}
