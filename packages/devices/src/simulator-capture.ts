import { z } from "zod";
import { framePacket, type Frame } from "@ace/screen";
import type { ScreenLegacyFrameHeader, ScreenStreamSettings } from "@ace/protocol";
import type { AppDevice } from "@ace/protocol/devices";
import type { DeviceCapture } from "./capture.ts";
import type { DeviceRuntime } from "./runtime.ts";
import { SimulatorInput } from "./simulator-input.ts";
import { SimulatorJpeg } from "./simulator-jpeg.ts";
import { SimulatorH264 } from "./simulator-h264.ts";
import {
  simulatorNeedsTranscode,
  startSimulatorTranscode,
  type SimulatorTranscode,
} from "./simulator-transcode.ts";
import { simulatorUI } from "./simulator-ui.ts";
import { nativeId } from "./commands.ts";
import { knownOrientation, simulatorRotation } from "./simulator-rotation.ts";
import { DeviceError } from "./sdk.ts";
import { pinnedServeSim } from "./serve-sim-version.ts";
import { startSimulatorDigitizer, type SimulatorDigitizer } from "./simulator-digitizer.ts";
import { touchTarget, type SimulatorScreen } from "./simulator-screens.ts";

const Endpoint = z.object({
  device: z.string().uuid(),
  port: z.number().int().min(1).max(65535),
  streamUrl: z.string().max(4096),
  wsUrl: z.string().max(4096),
});
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
 * this UDID. Live views get serve-sim's H.264 as-is, unless a viewer can't carry it (its link is
 * under 5 Mbit/s, or its panel is smaller than the native picture): then the screen helper
 * re-encodes it (`--transcode`, hardware) at the size and rate asked for. Its MJPEG, resized,
 * only feeds agents' stills and recordings while nobody watches.
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
  /** The screen helper, to re-encode for a viewer who can't carry serve-sim's stream. */
  transcoder?: string;
  /** The screen helper, to touch the Simulator through Xcode's own input service. */
  digitizer?: string;
  /** The Simulator's built-in screens, so a touch reaches the one in the picture. */
  screens?: () => Promise<readonly SimulatorScreen[]>;
}): Promise<DeviceCapture> {
  const { runtime } = options;
  const fetcher = runtime.fetch ?? fetch;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  controller.signal.throwIfAborted();
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
  let h264: SimulatorH264 | undefined;
  /** Re-encoding for a thin link or a small panel; undefined while serve-sim passes through. */
  let transcode: SimulatorTranscode | undefined;
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
        h264?.stop(),
        transcode?.stop(),
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
  void child.exited.then((exit) => {
    if (!stopped && (!announced || exit.code !== 0))
      failed(new Error("Simulator framebuffer helper stopped"));
  });
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
          if (options.screens) void readScreens(options.screens);
          sized.resolve();
          // A portrait-only app shows no new picture when the device turns; resend one so
          // viewers learn the new rotation anyway.
          if (input && simulatorRotation(screen.orientation) !== before)
            void (mode === "h264" ? h264?.keyframe() : jpeg?.replay())?.catch(() => {});
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
        void Promise.resolve(screensRead).finally(() => {
          giveUp();
          resolve();
        });
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
    const toH264 = async (): Promise<"h264"> => {
      if (h264) return "h264";
      const source = new SimulatorH264({
        url: avccUrl,
        fetch: fetcher,
        after: runtime.after,
        failure: failed,
        publish(payload, keyframe, config) {
          if (stopped || h264 !== source) return;
          // The first IDR is the switch: later JPEG frames are dropped from here on.
          mode = "h264";
          Object.assign(screen, { width: config.width, height: config.height });
          native = { width: config.width, height: config.height };
          if (transcode) return transcode.push(payload, keyframe, sequence, runtime.now());
          publish(
            {
              version: 1,
              sessionId: options.streamId,
              sequence: sequence++,
              timestamp: runtime.now(),
              width: config.width,
              height: config.height,
              scale: 1,
              codec: "h264",
              keyframe,
              ...(keyframe ? { videoCodec: config.codec } : {}),
              bytes: payload.length,
            },
            payload,
          );
        },
      });
      h264 = source;
      try {
        await source.start();
      } catch (error) {
        // A live view is video or nothing: say so rather than hand it JPEG.
        if (h264 === source) h264 = undefined;
        await source.stop();
        controller.signal.throwIfAborted();
        if (stopped) throw error;
        throw new DeviceError(
          "command_failed",
          "serve-sim's H.264 stream didn't start",
          `Open the live view again. If it keeps failing, download device tools again in Devices (serve-sim ${pinnedServeSim}).`,
        );
      }
      const previous = jpeg;
      jpeg = undefined;
      await previous?.stop();
      return "h264";
    };
    const stopTranscode = async () => {
      const previous = transcode;
      transcode = undefined;
      await previous?.stop();
    };
    /**
     * serve-sim's stream as it is while the viewers can carry it; re-encoded at their size and
     * rate when they can't. Each switch starts from a keyframe, so a viewer's decoder can follow.
     */
    const followViewer = async (settings: ScreenStreamSettings) => {
      const helper = options.transcoder;
      if (!helper) return;
      const need = simulatorNeedsTranscode({
        transcoding: transcode !== undefined,
        bitrate: settings.bitrate,
        box: settings,
        native,
      });
      if (need) {
        if (!transcode) {
          transcode = startSimulatorTranscode({
            helper,
            runtime,
            env: options.env,
            // The re-encoder went away: serve-sim's own stream keeps the view going.
            failed: () =>
              void stopTranscode()
                .then(() => h264?.keyframe())
                .catch(() => {}),
            frame: (frame) => {
              if (stopped) return;
              const scale = native ? frame.header.width / native.width : 1;
              publish(
                {
                  version: 1,
                  sessionId: options.streamId,
                  sequence: sequence++,
                  timestamp: runtime.now(),
                  width: frame.header.width,
                  height: frame.header.height,
                  scale,
                  codec: "h264",
                  keyframe: frame.header.keyframe === true,
                  ...(frame.header.videoCodec ? { videoCodec: frame.header.videoCodec } : {}),
                  bytes: frame.payload.length,
                },
                frame.payload,
              );
            },
          });
          // The transcoder's decoder starts at serve-sim's next IDR.
          void h264?.keyframe().catch(() => {});
        }
        transcode.settings({
          bitrate: settings.bitrate,
          maxWidth: settings.maxWidth,
          maxHeight: settings.maxHeight,
        });
      } else if (transcode) {
        await stopTranscode();
        // Back to serve-sim's own stream: viewers start again from its next IDR.
        void h264?.keyframe().catch(() => {});
      }
    };
    const toJpeg = async (settings: ScreenStreamSettings): Promise<"jpeg"> => {
      const source = jpeg ?? (await startJpeg(streamUrl));
      mode = "jpeg";
      const previous = h264;
      h264 = undefined;
      await previous?.stop();
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
          await stopTranscode();
          return { codec: await toJpeg(settings) };
        }
        const codec = await toH264();
        await followViewer(settings);
        return { codec };
      },
      keyframe: async () => {
        controller.signal.throwIfAborted();
        if (transcode) transcode.keyframe();
        else if (mode === "h264" && h264) await h264.keyframe();
        else await jpeg?.replay();
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
