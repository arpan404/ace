import { PublicToolError } from "./public-error.ts";
import { maxModelImageBytes } from "./result-budgets.ts";
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
  if (
    width === frame.width &&
    height === frame.height &&
    frame.payload.length <= maxModelImageBytes
  )
    return { ...frame, scale };
  const timeout = new AbortController();
  const cancelTimeout = runtime.after(10_000, () => timeout.abort());
  const lifetime = AbortSignal.any([signal, timeout.signal]);
  let fitted: { bytes: Buffer; width: number; height: number } | undefined;
  try {
    // Lower qualities only when a busy screen doesn't fit the model's byte budget.
    for (const quality of qualities) {
      fitted = await abortable(runtime.fit(frame.payload, { width, height }, quality), lifetime);
      if (fitted.bytes.length <= maxModelImageBytes) break;
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ModelImageError) throw error;
    throw new ModelImageError("Screenshot resize failed");
  } finally {
    cancelTimeout();
  }
  if (!fitted || fitted.bytes.length > maxModelImageBytes)
    throw new ModelImageError("Resized screenshot exceeds 1 MiB");
  signal.throwIfAborted();
  // The resize keeps the image's shape; its own size is what the agent's points map to.
  return {
    payload: fitted.bytes,
    width: fitted.width,
    height: fitted.height,
    scale: fitted.width === width ? scale : (scale * fitted.width) / width,
  };
}

const qualities = [85, 60, 40];

/** `work`, or a `ModelImageError` as soon as `signal` aborts (the caller's, or the deadline). */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ModelImageError("Screenshot resize cancelled"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ModelImageError("Screenshot resize cancelled or timed out"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
