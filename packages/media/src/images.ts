import {
  imagePayloadBytes,
  type ImageFailure,
  type ImageInput,
  type ImageOp,
} from "./image-wire.ts";
import type { MediaPhase } from "./diagnostics.ts";
import type { MediaClock } from "./supervisor-host.ts";
import type { FromMedia, ToMedia } from "./wire.ts";

/*
 * One-shot image jobs through ace-media (ADR 0201 §6): the daemon's only way to decode, fit,
 * convert or composite a picture. Each job settles exactly once: with ace-media's image, its
 * refusal, or the daemon's own `unavailable`, `exited`, `deadline` or `cancelled`. Nothing
 * here waits past a job's deadline, so no caller (and no agent's state) is held by it.
 */

/** An input as the caller has it: bytes for the payload, raw pixels, or a file ace wrote. */
export type ImageJobInput =
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "rgba"; bytes: Uint8Array; width: number; height: number }
  | { kind: "file"; path: string; maxBytes: number };

export type ImageJob = {
  inputs: readonly ImageJobInput[];
  op: ImageOp;
  /** How long the job may take, ace-media's start included. */
  deadlineMs: number;
  signal?: AbortSignal | undefined;
};

type Done = Extract<FromMedia, { type: "image.done" }>;
export type ImageResult = Pick<Done, "width" | "height" | "format" | "source"> & {
  bytes: Uint8Array;
};

/** ace-media's reasons, and the daemon's: ace-media can't run, or went away mid-job. */
export type ImageErrorReason = ImageFailure | "unavailable" | "exited";

export class ImageError extends Error {
  readonly reason: ImageErrorReason;
  constructor(reason: ImageErrorReason, message: string) {
    super(message);
    this.name = "ImageError";
    this.reason = reason;
  }
  /** Whether the same job may work later (ace-media busy, starting, gone, or slow). */
  get passing(): boolean {
    return ["busy", "deadline", "cancelled", "shutdown", "unavailable", "exited"].includes(
      this.reason,
    );
  }
}

/** What callers are given: one job in, one result or `ImageError` out. */
export interface ImageWork {
  run(job: ImageJob): Promise<ImageResult>;
}

/** Image work that always fails `unavailable`, for a daemon that can't run ace-media. */
export function unavailableImages(reason: string): ImageWork {
  return {
    run: () => Promise.reject(new ImageError("unavailable", `ace-media is unavailable: ${reason}`)),
  };
}

/** The most a job's inputs may carry in one frame, leaving room for its JSON. */
export const maxImagePayload = 8 * 1024 * 1024 - 64 * 1024;
/** Jobs that may wait for ace-media to come up. */
export const maxQueuedImages = 32;
/**
 * Payload bytes the daemon may hold for jobs not yet answered, queued or written: past this a
 * job is refused `busy`, so image work can't grow the daemon's memory or its lane's queue.
 */
export const maxHeldImageBytes = 32 * 1024 * 1024;

export type MediaImagesOptions = {
  /** False when ace-media can't take the message now. */
  send: (message: ToMedia, payload: Uint8Array) => boolean;
  /** Takes a use of ace-media, starting it whatever the media settings; returns the release. */
  require: () => () => void;
  /** Where the supervisor is, and why it is unavailable when it is. */
  phase: () => { phase: MediaPhase; reason?: string | undefined };
  clock: MediaClock;
  /** A request id unique for this daemon's lifetime. */
  nextId: () => string;
};

type Job = {
  id: string;
  /** Its payload's size, held against `maxHeldImageBytes` until it settles. */
  size: number;
  message: Extract<ToMedia, { type: "image.job" }>;
  payload: Uint8Array;
  sent: boolean;
  settle: (result: ImageResult | ImageError) => void;
};

export class MediaImages implements ImageWork {
  readonly #options: MediaImagesOptions;
  readonly #jobs = new Map<string, Job>();
  #held = 0;

  constructor(options: MediaImagesOptions) {
    this.#options = options;
  }

  /** Jobs not yet settled: waiting for ace-media, or sent. */
  get pending(): number {
    return this.#jobs.size;
  }

  run(job: ImageJob): Promise<ImageResult> {
    const { require, phase, clock, nextId } = this.#options;
    const inputs: ImageInput[] = job.inputs.map((input) =>
      input.kind === "file"
        ? input
        : input.kind === "rgba"
          ? { kind: "rgba", bytes: input.bytes.length, width: input.width, height: input.height }
          : { kind: "bytes", bytes: input.bytes.length },
    );
    const size = imagePayloadBytes(inputs);
    if (size > maxImagePayload)
      return Promise.reject(
        new ImageError("too-large", `The image is ${size} bytes, more than one job carries.`),
      );
    if (job.signal?.aborted)
      return Promise.reject(new ImageError("cancelled", "The image job was cancelled."));
    const state = phase();
    if (state.phase === "unavailable")
      return Promise.reject(
        new ImageError("unavailable", `ace-media is unavailable: ${state.reason ?? "unknown"}`),
      );
    if ([...this.#jobs.values()].filter((j) => !j.sent).length >= maxQueuedImages)
      return Promise.reject(new ImageError("busy", "Too many image jobs are waiting."));
    if (this.#held + size > maxHeldImageBytes)
      return Promise.reject(
        new ImageError(
          "busy",
          "Too many image bytes are waiting for ace-media; try again shortly.",
        ),
      );
    const payload = new Uint8Array(size);
    let at = 0;
    for (const input of job.inputs)
      if (input.kind !== "file") {
        payload.set(input.bytes, at);
        at += input.bytes.length;
      }
    const id = nextId();
    const message = {
      type: "image.job" as const,
      request: id,
      deadlineMs: Math.max(1, Math.ceil(job.deadlineMs)),
      inputs,
      op: job.op,
    };
    return new Promise<ImageResult>((resolve, reject) => {
      const release = require();
      const abort = () =>
        this.#end(id, new ImageError("cancelled", "The image job was cancelled."), true);
      const cancelTimer = clock.setTimeout(
        () =>
          this.#end(id, new ImageError("deadline", "The image job ran past its deadline."), true),
        job.deadlineMs,
      );
      job.signal?.addEventListener("abort", abort, { once: true });
      this.#held += size;
      this.#jobs.set(id, {
        id,
        size,
        message,
        payload,
        sent: false,
        settle: (result) => {
          cancelTimer();
          job.signal?.removeEventListener("abort", abort);
          release();
          if (result instanceof ImageError) reject(result);
          else resolve(result);
        },
      });
      this.#flush();
    });
  }

  /** ace-media's lanes are up: queued jobs go now. */
  ready(): void {
    this.#flush();
  }

  /** A message from ace-media; those about other requests are ignored. */
  message(message: FromMedia, payload: Uint8Array): void {
    if (message.type !== "image.done" && message.type !== "image.failed") return;
    const job = this.#jobs.get(message.request);
    if (!job?.sent) return;
    if (message.type === "image.failed")
      this.#end(job.id, new ImageError(message.reason, message.message));
    else {
      const { width, height, format, source } = message;
      // The payload buffer may be reused once this returns.
      this.#end(job.id, { width, height, format, source, bytes: payload.slice() });
    }
  }

  /**
   * ace-media exited. Jobs it held fail `exited` and are not retried: an input that crashed it
   * must not crash the next process too. Jobs still waiting for it keep waiting for the
   * restart within their deadlines, unless it is now unavailable.
   */
  exited(): void {
    const state = this.#options.phase();
    for (const job of this.#jobs.values()) {
      if (job.sent)
        this.#end(job.id, new ImageError("exited", "ace-media exited during the image job."));
      else if (state.phase === "unavailable")
        this.#end(
          job.id,
          new ImageError("unavailable", `ace-media is unavailable: ${state.reason ?? "unknown"}`),
        );
    }
  }

  #flush(): void {
    for (const job of this.#jobs.values()) {
      if (job.sent) continue;
      // The send owns the payload from here, so it gets a copy the job can't lose.
      if (!this.#options.send(job.message, job.payload.slice())) return;
      job.sent = true;
      job.payload = new Uint8Array(0);
    }
  }

  #end(id: string, result: ImageResult | ImageError, tell = false): void {
    const job = this.#jobs.get(id);
    if (!job) return;
    this.#jobs.delete(id);
    this.#held -= job.size;
    if (tell && job.sent)
      this.#options.send({ type: "image.cancel", request: id }, new Uint8Array(0));
    job.settle(result);
  }
}
