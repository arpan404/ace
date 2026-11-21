import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ImageError, type ImageJob, type ImageResult, type ImageWork } from "../images.ts";
import { imagePayloadBytes, type ImageInput } from "../image-wire.ts";
import { mediaBinaryPath } from "../media-binary.ts";
import { decodeFromMedia, encodeControl } from "../wire.ts";

/*
 * Image work for tests and tools: each job runs through a built ace-media's one-shot mode
 * (`ace-media --image`, ADR 0201 §8), the same decoders the daemon's ace-media uses. Tests that
 * need real pixels skip where no binary is built (`testMediaBinary()` undefined).
 */

/** `ACE_MEDIA_TEST_BINARY`, else this tree's Cargo build, else undefined. */
export function testMediaBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = env.ACE_MEDIA_TEST_BINARY?.trim();
  if (named) return named;
  return mediaBinaryPath({
    mode: "development",
    env: {},
    sourceRoot: fileURLToPath(new URL("../../../../", import.meta.url)),
    platform: process.platform,
    exists: existsSync,
  });
}

/**
 * One job through `binary --image`. File inputs are read only inside `root` (by default the
 * filesystem root: tests name their files where they made them).
 */
export function binaryImages(binary: string, options: { root?: string } = {}): ImageWork {
  const args = ["--image", "--root", options.root ?? "/"];
  let next = 0;
  return {
    run: (job: ImageJob) => {
      const inputs: ImageInput[] = job.inputs.map((input) =>
        input.kind === "file"
          ? // The process walks the path without following links; a test's temporary folder
            // may sit behind one (macOS's /var), so it gets the resolved path.
            { ...input, path: options.root ? input.path : resolved(input.path) }
          : input.kind === "rgba"
            ? { kind: "rgba", bytes: input.bytes.length, width: input.width, height: input.height }
            : { kind: "bytes", bytes: input.bytes.length },
      );
      const payload = new Uint8Array(imagePayloadBytes(inputs));
      let at = 0;
      for (const input of job.inputs)
        if (input.kind !== "file") {
          payload.set(input.bytes, at);
          at += input.bytes.length;
        }
      const message = {
        type: "image.job" as const,
        request: `test-${++next}`,
        deadlineMs: job.deadlineMs,
        inputs,
        op: job.op,
      };
      const frame = encodeControl(message, payload, "normal");
      return new Promise<ImageResult>((resolve, reject) => {
        const child = spawn(binary, args, { stdio: ["pipe", "pipe", "inherit"] });
        const chunks: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) return reject(new Error(`ace-media --image exited ${code}`));
          const { message: answer, payload: bytes } = decodeFromMedia(
            new Uint8Array(Buffer.concat(chunks)),
            "normal",
          );
          if (answer.type === "image.failed") reject(new ImageError(answer.reason, answer.message));
          else if (answer.type === "image.done")
            resolve({
              width: answer.width,
              height: answer.height,
              format: answer.format,
              source: answer.source,
              bytes: bytes.slice(),
            });
          else reject(new Error(`ace-media --image answered ${answer.type}`));
        });
        child.stdin.end(Buffer.concat([frame.header, frame.payload]));
      });
    },
  };
}

function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Straight RGBA pixels of an encoded image, through `work`: for tests that look at them. */
export async function imagePixels(
  work: ImageWork,
  bytes: Uint8Array,
): Promise<{ width: number; height: number; data: Uint8Array }> {
  const result = await work.run({
    inputs: [{ kind: "bytes", bytes }],
    op: {
      op: "fit",
      maxPixels: 50_000_000,
      width: 8192,
      height: 8192,
      autoOrient: false,
      output: { format: "rgba" },
    },
    deadlineMs: 10_000,
  });
  return { width: result.width, height: result.height, data: result.bytes };
}

/** An encoded image of one colour, made by `work`: a fixture for tests. */
export async function solidImage(
  work: ImageWork,
  size: { width: number; height: number },
  rgba: readonly [number, number, number, number],
  output: { format: "png" } | { format: "jpeg"; quality: number },
): Promise<Uint8Array> {
  const result = await work.run({
    inputs: [],
    op: {
      op: "compose",
      width: size.width,
      height: size.height,
      background: [rgba[0], rgba[1], rgba[2], rgba[3]],
      maxPixels: size.width * size.height,
      layers: [],
      output,
    },
    deadlineMs: 10_000,
  });
  return result.bytes;
}
