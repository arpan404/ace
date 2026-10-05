import { PublicToolError } from "./public-error.ts";
import { modelImageGeometry } from "./image-geometry.ts";
import { systemModelImageRuntime, type ModelImageRuntime } from "./model-image-runtime.ts";

export interface ModelImage {
  payload: Buffer;
  width: number;
  height: number;
  scale: number;
}
export class ModelImageError extends PublicToolError {
  constructor(_message?: string) {
    super("screenshot_failed");
  }
}
/** I/O boundary shared by screen and device MCP; live viewer frames remain untouched. */
export async function modelImage(
  frame: { payload: Buffer; width: number; height: number; scale?: number | undefined },
  signal: AbortSignal,
  runtime: ModelImageRuntime = systemModelImageRuntime,
): Promise<ModelImage> {
  signal.throwIfAborted();
  const { width, height, scale } = modelImageGeometry(frame.width, frame.height, frame.scale);
  if (width === frame.width && height === frame.height && frame.payload.length <= 1024 * 1024)
    return { ...frame, scale };
  const command = await runtime.encoder();
  if (!command)
    throw new ModelImageError("Large screenshot requires ffmpeg to fit the model image limit");
  signal.throwIfAborted();
  const timeout = new AbortController();
  const cancelTimeout = runtime.after(10_000, () => timeout.abort());
  const lifetime = AbortSignal.any([signal, timeout.signal]);
  let payload: Buffer;
  try {
    payload = await new Promise<Buffer>((resolve, reject) => {
      const child = runtime.spawn(command, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-i",
        "pipe:0",
        "-vf",
        `scale=${width}:${height}`,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-q:v",
        "5",
        "pipe:1",
      ]);
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: Error | undefined;
      const abort = () => {
        failure = new ModelImageError("Screenshot resize cancelled or timed out");
        child.kill("SIGKILL");
      };
      lifetime.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          failure = new ModelImageError("Resized screenshot exceeds 1 MiB");
          child.kill("SIGKILL");
        } else chunks.push(chunk);
      });
      // Drain diagnostics without exposing image/tool data or accumulating stderr.
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.once("error", () => {
        failure = new ModelImageError("Screenshot encoder could not start");
      });
      child.once("close", (code) => {
        lifetime.removeEventListener("abort", abort);
        if (failure || code !== 0 || !bytes)
          reject(failure ?? new ModelImageError("Screenshot encoder rejected the image"));
        else resolve(Buffer.concat(chunks));
      });
      if (lifetime.aborted) abort();
      else child.stdin.end(frame.payload);
    });
  } finally {
    cancelTimeout();
  }
  signal.throwIfAborted();
  return { payload, width, height, scale };
}
