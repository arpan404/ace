import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { ImageError, type ImageJobInput, type ImageResult, type ImageWork } from "./images.ts";
import { ImageOp } from "./image-wire.ts";
import { MediaRuntime } from "./runtime.ts";
import { legacyMediaSettings, nodeMediaHost, systemMediaClock } from "./supervisor.ts";
import { binaryImages, imagePixels, testMediaBinary } from "./testing/images.ts";

/*
 * ADR 0201 against the built binary: every shared image vector answers the same through the
 * daemon's supervised ace-media as through `ace-media --image`, and image jobs start ace-media
 * lazily while every media setting is still `legacy`.
 */

const binary = testMediaBinary();
const vectors = new URL("../../../native/media/vectors/image/", import.meta.url);
const Case = z.object({
  name: z.string(),
  inputs: z.array(
    z.union([z.string(), z.object({ rgba: z.string(), width: z.number(), height: z.number() })]),
  ),
  op: ImageOp,
  done: z
    .object({ width: z.number(), height: z.number(), format: z.string(), source: z.unknown() })
    .partial({ source: true })
    .optional(),
  failed: z.string().optional(),
  pixels: z.array(z.tuple([z.number(), z.number(), z.array(z.number()), z.number()])).optional(),
});
const cases = z
  .object({ cases: z.array(Case) })
  .parse(JSON.parse(readFileSync(new URL("cases.json", vectors), "utf8"))).cases;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function supervised(): MediaRuntime {
  if (!binary) throw new Error("no ace-media binary");
  const runtimeDir = mkdtempSync(join(tmpdir(), "acem-x4-"));
  let ids = 0;
  const runtime = new MediaRuntime({
    version: execFileSync(binary, ["--version"]).toString().trim(),
    binary,
    runtimeDir,
    dataDir: runtimeDir,
    // Every setting legacy: only image jobs want ace-media.
    settings: () => legacyMediaSettings,
    host: nodeMediaHost(process.env),
    clock: systemMediaClock,
    random: Math.random,
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    id: () => `id-${++ids}`,
    log: () => {},
  });
  cleanups.push(() => {
    runtime.dispose();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  return runtime;
}

function inputs(names: z.infer<typeof Case>["inputs"]): ImageJobInput[] {
  return names.map((input) =>
    typeof input === "string"
      ? { kind: "bytes", bytes: new Uint8Array(readFileSync(new URL(`inputs/${input}`, vectors))) }
      : {
          kind: "rgba",
          bytes: new Uint8Array(readFileSync(new URL(`inputs/${input.rgba}`, vectors))),
          width: input.width,
          height: input.height,
        },
  );
}

async function replay(work: ImageWork, pixels: ImageWork): Promise<void> {
  for (const vector of cases) {
    const result: ImageResult | ImageError = await work
      .run({ inputs: inputs(vector.inputs), op: vector.op, deadlineMs: 10_000 })
      .catch((error: unknown) => {
        if (error instanceof ImageError) return error;
        throw error;
      });
    if (vector.failed) {
      expect(result instanceof ImageError && result.reason, vector.name).toBe(vector.failed);
      continue;
    }
    if (result instanceof ImageError)
      throw new Error(`${vector.name}: ${result.reason} ${result.message}`);
    expect(
      { width: result.width, height: result.height, format: result.format },
      vector.name,
    ).toEqual({
      width: vector.done?.width,
      height: vector.done?.height,
      format: vector.done?.format,
    });
    if (vector.done?.source) expect(result.source, vector.name).toEqual(vector.done.source);
    if (!vector.pixels) continue;
    const data =
      result.format === "rgba" ? result.bytes : (await imagePixels(pixels, result.bytes)).data;
    for (const [x, y, want, tolerance] of vector.pixels) {
      const at = (y * result.width + x) * 4;
      const got = [...data.subarray(at, at + 4)];
      for (const [c, value] of want.entries())
        expect(
          Math.abs((got[c] ?? -1) - value),
          `${vector.name} (${x}, ${y}) ${got.join()}`,
        ).toBeLessThanOrEqual(tolerance);
    }
  }
}

it.skipIf(!binary)(
  "every image vector answers as recorded through ace-media --image",
  async () => {
    if (!binary) return;
    await replay(binaryImages(binary), binaryImages(binary));
  },
  60_000,
);

it.skipIf(!binary)(
  "with every media setting legacy, an image job starts ace-media and every vector answers through the lanes",
  async () => {
    if (!binary) return;
    const runtime = supervised();
    expect(runtime.supervisor.snapshot().pid).toBeUndefined();
    await replay(runtime.images, binaryImages(binary));
    expect(runtime.supervisor.snapshot().phase).toBe("running");
    expect(runtime.images.pending).toBe(0);
  },
  60_000,
);

it.skipIf(!binary)(
  "a file ace wrote is read by ace-media, and one over its bound is refused",
  async () => {
    if (!binary) return;
    const runtime = supervised();
    const directory = mkdtempSync(join(tmpdir(), "acem-x4-file-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "red.jpg");
    writeFileSync(path, readFileSync(new URL("inputs/red-64x48.jpg", vectors)));
    const op = {
      op: "fit",
      maxPixels: 1 << 20,
      width: 16,
      height: 16,
      autoOrient: false,
      output: { format: "png" },
    } as const;
    const fitted = await runtime.images.run({
      inputs: [{ kind: "file", path, maxBytes: 4096 }],
      op,
      deadlineMs: 10_000,
    });
    expect([fitted.width, fitted.height, fitted.format]).toEqual([16, 12, "png"]);
    const refused = await runtime.images
      .run({ inputs: [{ kind: "file", path, maxBytes: 100 }], op, deadlineMs: 10_000 })
      .catch((error: unknown) => error);
    expect(refused instanceof ImageError && refused.reason).toBe("too-large");
  },
  30_000,
);

it.skipIf(!binary)(
  "killing ace-media mid-job fails the job as exited, and the next job runs on the restart",
  async () => {
    if (!binary) return;
    const runtime = supervised();
    const probe = {
      inputs: inputs(["red-64x48.jpg"]),
      op: { op: "probe", maxPixels: 1 << 20 } as const,
      deadlineMs: 20_000,
    };
    await runtime.images.run(probe);
    const pid = runtime.supervisor.snapshot().pid;
    expect(pid).toBeDefined();
    // A job on the way when the process dies: it ends `exited`, never hanging to its deadline.
    const held = runtime.images.run({
      ...probe,
      inputs: inputs(Array.from({ length: 40 }, () => "icon.ico")),
      op: {
        op: "compose",
        width: 4000,
        height: 4000,
        background: [0, 0, 0, 255],
        maxPixels: 16_000_000,
        layers: Array.from({ length: 40 }, (_, input) => ({
          kind: "image" as const,
          input,
          left: 0,
          top: 0,
          width: 4000,
          height: 4000,
          fit: "fill" as const,
        })),
        output: { format: "png" },
      },
    });
    process.kill(pid ?? 0, "SIGKILL");
    const error = await held.catch((e: unknown) => e);
    expect(error instanceof ImageError && error.reason).toBe("exited");
    expect(runtime.images.pending).toBe(0);
    const again = await runtime.images.run(probe);
    expect([again.width, again.height]).toEqual([64, 48]);
    expect(runtime.supervisor.snapshot().pid).not.toBe(pid);
  },
  30_000,
);
