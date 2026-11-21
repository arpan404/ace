import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { ImageProcess } from "./image-process.ts";
import { ImageError, type ImageJobInput, type ImageResult, type ImageWork } from "./images.ts";
import { ImageOp } from "./image-wire.ts";
import { nodeMediaHost, systemMediaClock } from "./supervisor.ts";
import { binaryImages, imagePixels, testMediaBinary } from "./testing/images.ts";

/*
 * ADR 0208 against the built binary: every shared image vector answers the same through the
 * daemon's supervised image process (`ace-media --images`) as through `ace-media --image`; file
 * inputs are read only inside its root; and a killed image process fails its job and restarts.
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

/** The image process as the daemon runs it, its file root a fresh directory. */
function supervised(): { images: ImageProcess; root: string } {
  if (!binary) throw new Error("no ace-media binary");
  const root = mkdtempSync(join(tmpdir(), "acem-x4-"));
  let ids = 0;
  const images = new ImageProcess({
    binary,
    root,
    spawn: (command, args) =>
      nodeMediaHost(process.env, (path) => ({ command: path, args: [...args] })).spawn(command),
    clock: systemMediaClock,
    nextId: () => `id-${++ids}`,
    random: Math.random,
    log: () => {},
  });
  cleanups.push(() => {
    images.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return { images, root };
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
  "every image vector answers the same through the supervised image process",
  async () => {
    if (!binary) return;
    const { images } = supervised();
    expect(images.pid()).toBeUndefined();
    await replay(images, binaryImages(binary));
    expect(images.pid()).toBeDefined();
    expect(images.pending).toBe(0);
  },
  60_000,
);

it.skipIf(!binary)(
  "a file inside the root is read, one over its bound or outside the root is refused",
  async () => {
    if (!binary) return;
    const { images, root } = supervised();
    const outside = mkdtempSync(join(tmpdir(), "acem-x4-outside-"));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    const jpeg = readFileSync(new URL("inputs/red-64x48.jpg", vectors));
    writeFileSync(join(root, "red.jpg"), jpeg);
    writeFileSync(join(outside, "red.jpg"), jpeg);
    const op = {
      op: "fit",
      maxPixels: 1 << 20,
      width: 16,
      height: 16,
      autoOrient: false,
      output: { format: "png" },
    } as const;
    const read = (path: string, maxBytes: number) =>
      images
        .run({ inputs: [{ kind: "file", path, maxBytes }], op, deadlineMs: 10_000 })
        .catch((error: unknown) => error);
    const fitted = await read(join(root, "red.jpg"), 4096);
    expect(fitted instanceof ImageError ? fitted.message : fitted).toMatchObject({
      width: 16,
      height: 12,
      format: "png",
    });
    const big = await read(join(root, "red.jpg"), 100);
    expect(big instanceof ImageError && big.reason).toBe("too-large");
    const away = await read(join(outside, "red.jpg"), 4096);
    expect(away instanceof ImageError && away.reason).toBe("unreadable");
  },
  30_000,
);

it.skipIf(!binary)(
  "killing the image process fails its job as exited, and the next job runs on a new one",
  async () => {
    if (!binary) return;
    const { images } = supervised();
    const probe = {
      inputs: inputs(["red-64x48.jpg"]),
      op: { op: "probe", maxPixels: 1 << 20 } as const,
      deadlineMs: 20_000,
    };
    await images.run(probe);
    const pid = images.pid();
    expect(pid).toBeDefined();
    // A job on the way when the process dies: it ends `exited`, never hanging to its deadline.
    const held = images.run({
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
    expect(images.pending).toBe(0);
    const again = await images.run(probe);
    expect([again.width, again.height]).toEqual([64, 48]);
    expect(images.pid()).not.toBe(pid);
  },
  30_000,
);
