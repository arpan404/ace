import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { binaryImages, imagePixels, solidImage, testMediaBinary } from "@ace/media/testing/images";
import { expect, onTestFinished, test } from "vitest";
import { DeviceId, type ServerMessage, SpadeClientMessage } from "@ace/protocol";
import type { z } from "zod";
import { SpadePreviewGate, spadePreviewGate } from "../spade/image-preview.ts";
import { createSpadeSession } from "./spade-session.ts";

/*
 * A picture in a Spade conversation, previewed (`GET /v1/images/{sha256}?preview`): the daemon
 * reads the image from Spade and answers a PNG at most 512 pixels a side, as a thread's
 * attachment thumbnail, so a phone drawing a chat never downloads every original whole.
 */

const hash = "a".repeat(64);
/* Real previews come from ace-media's image work (ADR 0208): a built binary, or none to test. */
const binary = testMediaBinary();
const images = binaryImages(binary ?? "");
const decoding = test.skipIf(!binary);
/** A preview's PNG signature and decoded size, read back through ace-media. */
async function previewed(body: string) {
  const png = Buffer.from(body, "base64");
  const { width, height } = await imagePixels(images, png);
  return { signature: png.subarray(1, 4).toString("latin1"), width, height };
}

/** A Spade serving `body` with `type` at `/v1/images/{hash}`; `seen` is every path it was asked. */
async function spadeServing(body: Buffer, type: string) {
  const seen: string[] = [];
  const spade = createServer((request, response) => {
    seen.push(request.url ?? "");
    request.resume();
    if (request.url !== `/v1/images/${hash}`) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(200, { "content-type": type });
    response.end(body);
  });
  await new Promise<void>((resolve) => spade.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise((resolve) => spade.close(() => resolve())));
  const address = spade.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return { port: address.port, seen };
}

/** One socket's session forwarding to Spade on `port`, previews through `previews`. */
function socket(port: number, previews?: SpadePreviewGate) {
  const sent: ServerMessage[] = [];
  const service = createSpadeSession({
    options: {
      spade: {
        ready: () => ({
          connection: { host: "127.0.0.1", port, token: "t".repeat(64) },
          generation: 1,
        }),
        status: () => ({ state: "ready" }),
        subscribe: () => () => {},
        onRunEnded: () => () => {},
        ...(previews ? { previews } : {}),
      },
    },
    authorize: () => true,
    connected: () => true,
    send: (message) => sent.push(message as ServerMessage),
    device: () => DeviceId.parse("phone"),
  });
  onTestFinished(() => service.close?.());
  let count = 0;
  /** Sends the request at once; the answer resolves when it comes. */
  const get = (path: string) => {
    const requestId = `r${count++}`;
    void service.handle?.(
      SpadeClientMessage.parse({
        type: "spade.http",
        requestId,
        method: "GET",
        path,
      } satisfies z.input<typeof SpadeClientMessage>),
      DeviceId.parse("phone"),
    );
    return (async () => {
      for (let tries = 0; tries < 500; tries++) {
        const found = sent.find(
          (message) => message.type === "spade.http.result" && message.requestId === requestId,
        );
        if (found?.type === "spade.http.result") return found.result;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`No result for ${path}`);
    })();
  };
  return { get, close: () => service.close?.() };
}

/** A socket previewing through ace-media's image work, and the paths Spade was asked. */
async function serving(body: Uint8Array, type: string) {
  const { port, seen } = await spadeServing(Buffer.from(body), type);
  return { get: socket(port, spadePreviewGate(images)).get, seen };
}

/** A gate whose decodes wait until the test lets them finish, counting those begun. */
function heldGate(places: { running: number; waiting: number; decodeMs?: number }) {
  const held: (() => void)[] = [];
  let begun = 0;
  const gate = new SpadePreviewGate({
    ...places,
    decodeMs: places.decodeMs ?? 10_000,
    render: () => {
      begun++;
      return new Promise<Buffer>((resolve) => held.push(() => resolve(Buffer.from("png"))));
    },
  });
  return {
    gate,
    begun: () => begun,
    finishAll: () => {
      for (const finish of held.splice(0)) finish();
    },
  };
}

const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
const previewPath = `/v1/images/${hash}?preview`;

decoding(
  "a picture's preview is a PNG at most 512 pixels a side, read from Spade's own image",
  async () => {
    const photo = await solidImage(images, { width: 2400, height: 1200 }, [0, 128, 128, 255], {
      format: "jpeg",
      quality: 85,
    });
    const { get, seen } = await serving(photo, "image/jpeg");

    const result = await get(`/v1/images/${hash}?preview`);

    if (result.kind !== "response") throw new Error(result.message);
    expect(result).toMatchObject({ status: 200, encoding: "base64", contentType: "image/png" });
    expect(await previewed(result.body)).toEqual({ signature: "PNG", width: 512, height: 256 });
    expect(seen).toEqual([`/v1/images/${hash}`]);
  },
);

test("the original is still forwarded whole when no preview is asked for", async () => {
  const photo = Buffer.from("the original's bytes, whatever they are");
  const { get } = await serving(photo, "image/jpeg");

  const result = await get(`/v1/images/${hash}`);

  if (result.kind !== "response") throw new Error(result.message);
  expect(Buffer.from(result.body, "base64").equals(photo)).toBe(true);
});

test("without ace-media a preview is refused as busy, never answered with the original", async () => {
  const { port } = await spadeServing(Buffer.from("image"), "image/png");

  const result = await socket(port).get(previewPath);

  expect(result).toMatchObject({ kind: "response", status: 503 });
});

decoding(
  "a preview of bytes that aren't a picture is refused, never forwarded as they are",
  async () => {
    const { get } = await serving(Buffer.from("not an image"), "image/png");

    const result = await get(`/v1/images/${hash}?preview`);

    expect(result).toMatchObject({ kind: "response", status: 422 });
  },
);

test("Spade's refusal of a missing picture comes back as it is", async () => {
  const { get } = await serving(Buffer.alloc(0), "image/png");

  const result = await get(`/v1/images/${"b".repeat(64)}?preview`);

  expect(result).toMatchObject({ kind: "response", status: 404 });
});

// HEIC decodes through the OS (ADR 0208): ImageIO on macOS.
test.skipIf(!binary || process.platform !== "darwin")(
  "a HEIC picture is previewed as a PNG too, by the same decoder",
  async () => {
    const heic = await readFile(
      new URL("../../../../packages/context/fixtures/colours.heic", import.meta.url),
    );
    const { get } = await serving(heic, "image/heic");

    const result = await get(`/v1/images/${hash}?preview`);

    if (result.kind !== "response") throw new Error(result.message);
    expect(await previewed(result.body)).toEqual({ signature: "PNG", width: 320, height: 240 });
  },
);

test("previews past the daemon's places are refused at once as busy, never fetched", async () => {
  const { port, seen } = await spadeServing(Buffer.from("image"), "image/png");
  const { gate, finishAll } = heldGate({ running: 1, waiting: 1 });
  const phone = socket(port, gate);

  const first = phone.get(previewPath);
  const second = phone.get(previewPath);
  const third = await phone.get(previewPath);

  expect(third).toMatchObject({ kind: "response", status: 503 });
  await settle();
  expect(seen).toHaveLength(1);
  finishAll();
  await settle();
  finishAll();
  expect(await first).toMatchObject({ status: 200, contentType: "image/png" });
  expect(await second).toMatchObject({ status: 200, contentType: "image/png" });
});

test("the places are the daemon's: a second socket finds them taken", async () => {
  const { port } = await spadeServing(Buffer.from("image"), "image/png");
  const { gate, finishAll } = heldGate({ running: 1, waiting: 0 });
  const laptop = socket(port, gate);
  const phone = socket(port, gate);

  const first = laptop.get(previewPath);
  await settle();

  expect(await phone.get(previewPath)).toMatchObject({ kind: "response", status: 503 });
  finishAll();
  expect(await first).toMatchObject({ status: 200 });
});

test("a socket that closes gives up its waiting place to the next", async () => {
  const { port } = await spadeServing(Buffer.from("image"), "image/png");
  const { gate, begun, finishAll } = heldGate({ running: 1, waiting: 1 });
  const laptop = socket(port, gate);
  const phone = socket(port, gate);
  void laptop.get(previewPath);
  void laptop.get(previewPath);
  await settle();

  laptop.close();
  const after = phone.get(previewPath);
  await settle();
  finishAll();
  await settle();
  finishAll();

  expect(await after).toMatchObject({ status: 200 });
  // The closed socket's waiting preview never decoded.
  expect(begun()).toBe(2);
});

test("a decode past its deadline answers busy, and keeps its place until it ends", async () => {
  const { port } = await spadeServing(Buffer.from("image"), "image/png");
  const { gate, begun, finishAll } = heldGate({ running: 1, waiting: 0, decodeMs: 50 });
  const phone = socket(port, gate);

  expect(await phone.get(previewPath)).toMatchObject({ kind: "response", status: 503 });
  // The late decode still holds the only place: the next is refused before it decodes.
  expect(await phone.get(previewPath)).toMatchObject({ kind: "response", status: 503 });
  expect(begun()).toBe(1);

  finishAll();
  await settle();
  void phone.get(previewPath);
  await settle();
  expect(begun()).toBe(2);
  finishAll();
});
