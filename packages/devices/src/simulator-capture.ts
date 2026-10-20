import { z } from "zod";
import { framePacket, type Frame } from "@ace/screen";
import type { ScreenLegacyFrameHeader, ScreenStreamSettings } from "@ace/protocol";
import type { AppDevice } from "@ace/protocol/devices";
import type { DeviceCapture } from "./capture.ts";
import type { DeviceRuntime } from "./runtime.ts";
import { SimulatorInput } from "./simulator-input.ts";
import { SimulatorJpeg } from "./simulator-jpeg.ts";
import { SimulatorH264 } from "./simulator-h264.ts";
import { simulatorUI } from "./simulator-ui.ts";
import { nativeId } from "./commands.ts";
import { simulatorRotation } from "./simulator-rotation.ts";
import { DeviceError } from "./sdk.ts";
import { pinnedServeSim } from "./serve-sim-version.ts";

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
 * this UDID. Live views get serve-sim's H.264 as-is. Its MJPEG, resized, only feeds agents'
 * stills and recordings while nobody watches.
 */
export async function simulatorCapture(options: {
  command: string;
  device: AppDevice;
  streamId: string;
  fps: number;
  env: NodeJS.ProcessEnv;
  runtime: DeviceRuntime;
  signal?: AbortSignal;
  publish(frame: Frame): void;
  failure(error: unknown): void;
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
    args: ["--no-preview", "--quiet", nativeId(options.device)],
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
      const end = output.indexOf(10);
      if (end < 0) return;
      const value = Endpoint.parse(JSON.parse(output.subarray(0, end).toString("utf8")));
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
          Object.assign(screen, config.data);
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
    input = new SimulatorInput({
      runtime,
      command: options.command,
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
    });
    const nativeInput = input;
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
          `Open the live view again. If it keeps failing, reinstall serve-sim: npm install -g serve-sim@${pinnedServeSim}`,
        );
      }
      const previous = jpeg;
      jpeg = undefined;
      await previous?.stop();
      return "h264";
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
        return { codec: settings.codec === "h264" ? await toH264() : await toJpeg(settings) };
      },
      keyframe: async () => {
        controller.signal.throwIfAborted();
        if (mode === "h264" && h264) await h264.keyframe();
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
