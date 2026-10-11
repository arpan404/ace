import { z } from "zod";
import { framePacket, type Frame } from "@ace/screen";
import type { AppDevice } from "@ace/protocol/devices";
import type { DeviceCapture } from "./capture.ts";
import type { DeviceRuntime } from "./runtime.ts";
import { MjpegDecoder } from "./mjpeg.ts";
import { SimulatorInput } from "./simulator-input.ts";
import { SimulatorFrames } from "./simulator-frames.ts";
import { nativeId } from "./commands.ts";

const Endpoint = z.object({
  device: z.string().uuid(),
  port: z.number().int().min(1).max(65535),
  streamUrl: z.string().max(4096),
  wsUrl: z.string().max(4096),
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

/** The public serve-sim CLI owns the native framebuffer and HID connection for this UDID. */
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
    sequence = 0,
    width = 0,
    height = 0;
  let terminated = false;
  let input: SimulatorInput | undefined;
  let frames: SimulatorFrames | undefined;
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
        frames?.stop(),
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
  let reading: Promise<void> | undefined;
  try {
    const value = await endpoint.promise;
    cancel();
    controller.signal.removeEventListener("abort", onAbort);
    controller.signal.throwIfAborted();
    const url = localUrl(value.streamUrl, value.port, "http:");

    const response = await (runtime.fetch ?? fetch)(url, {
      signal: controller.signal,
      redirect: "error",
    });
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get("content-type")?.startsWith("multipart/x-mixed-replace")
    )
      throw new Error("Simulator framebuffer stream unavailable");
    socket = (runtime.socket ?? ((endpointUrl) => new WebSocket(endpointUrl)))(
      localUrl(value.wsUrl, value.port, "ws:").href,
    );
    const connected = Promise.withResolvers<void>();
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
    try {
      await connected.promise;
    } finally {
      connectTimeout();
      controller.signal.removeEventListener("abort", socketAbort);
    }
    controller.signal.throwIfAborted();
    const boundary = /boundary=([A-Za-z0-9_-]{1,70})(?:;|$)/.exec(
      response.headers.get("content-type") ?? "",
    )?.[1];
    if (!boundary) throw new Error("Simulator multipart boundary unavailable");
    frames = new SimulatorFrames({
      fps: options.fps,
      now: runtime.now,
      after: runtime.after,
      failure: failed,
      publish(image, scale) {
        if (stopped) return;
        const header = {
          version: 1 as const,
          sessionId: options.streamId,
          sequence: sequence++,
          timestamp: runtime.now(),
          width: image.width,
          height: image.height,
          scale,
          codec: "jpeg" as const,
          bytes: image.bytes.length,
        };
        const packet = framePacket(header, image.bytes);
        options.publish({
          header,
          payload: packet.subarray(packet.length - image.bytes.length),
          packet,
        });
      },
    });
    const decoder = new MjpegDecoder(boundary, (image, w, h) => {
      width = w;
      height = h;
      frames?.push(image, w, h);
    });
    const body = response.body;
    reading = (async () => {
      for await (const chunk of body) {
        if (stopped) break;
        decoder.push(Buffer.from(chunk));
      }
      if (!stopped) throw new Error("Simulator framebuffer stream ended");
    })();
    void reading.catch(failed);
    input = new SimulatorInput({
      runtime,
      command: options.command,
      device: value.device,
      env: options.env,
      dimensions: () => ({ width, height }),
      send(tag, payload, cleanup) {
        if (socket?.readyState !== WebSocket.OPEN)
          throw new Error("Simulator control connection closed");
        if (!cleanup && socket.bufferedAmount > 65536)
          throw new Error("Simulator input backlog exceeded limit");
        socket.send(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))]));
      },
    });
    const nativeInput = input;
    const nativeFrames = frames;
    return {
      streamId: options.streamId,
      get terminated() {
        return terminated;
      },
      async stop() {
        await stop();
        await reading?.catch(() => {});
      },
      async configure(settings) {
        await nativeFrames.configure(settings);
        return { codec: "jpeg" };
      },
      keyframe: () => nativeFrames.replay(),
      releaseInput: () => nativeInput.release(),
      async input(raw, guard) {
        controller.signal.throwIfAborted();
        await nativeInput.input(raw, guard);
      },
    };
  } catch (error) {
    cancel();
    controller.signal.removeEventListener("abort", onAbort);
    await stop();
    throw error;
  }
}
