import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import sharp from "sharp";
import { expect, onTestFinished, test } from "vitest";
import { DeviceId, type ServerMessage, SpadeClientMessage } from "@ace/protocol";
import type { z } from "zod";
import { createSpadeSession } from "./spade-session.ts";

/*
 * A picture in a Spade conversation, previewed (`GET /v1/images/{sha256}?preview`): the daemon
 * reads the image from Spade and answers a PNG at most 512 pixels a side, as a thread's
 * attachment thumbnail, so a phone drawing a chat never downloads every original whole.
 */

const hash = "a".repeat(64);

/** A Spade serving `body` with `type` at `/v1/images/{hash}`, and a session forwarding to it. */
async function serving(body: Buffer, type: string) {
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
  const sent: ServerMessage[] = [];
  const service = createSpadeSession({
    options: {
      spade: {
        ready: () => ({
          connection: { host: "127.0.0.1", port: address.port, token: "t".repeat(64) },
          generation: 1,
        }),
        status: () => ({ state: "ready" }),
        subscribe: () => () => {},
        onRunEnded: () => () => {},
      },
    },
    authorize: () => true,
    connected: () => true,
    send: (message) => sent.push(message as ServerMessage),
    device: () => DeviceId.parse("phone"),
  });
  onTestFinished(() => service.close?.());
  const get = async (path: string) => {
    const requestId = `r${sent.length}-${path.length}`;
    await service.handle?.(
      SpadeClientMessage.parse({
        type: "spade.http",
        requestId,
        method: "GET",
        path,
      } satisfies z.input<typeof SpadeClientMessage>),
      DeviceId.parse("phone"),
    );
    for (let tries = 0; tries < 500; tries++) {
      const found = sent.find(
        (message) => message.type === "spade.http.result" && message.requestId === requestId,
      );
      if (found?.type === "spade.http.result") return found.result;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No result for ${path}`);
  };
  return { get, seen };
}

test("a picture's preview is a PNG at most 512 pixels a side, read from Spade's own image", async () => {
  const photo = await sharp({
    create: { width: 2400, height: 1200, channels: 3, background: "teal" },
  })
    .jpeg()
    .toBuffer();
  const { get, seen } = await serving(photo, "image/jpeg");

  const result = await get(`/v1/images/${hash}?preview`);

  if (result.kind !== "response") throw new Error(result.message);
  expect(result).toMatchObject({ status: 200, encoding: "base64", contentType: "image/png" });
  const preview = await sharp(Buffer.from(result.body, "base64")).metadata();
  expect(preview).toMatchObject({ format: "png", width: 512, height: 256 });
  expect(seen).toEqual([`/v1/images/${hash}`]);
});

test("the original is still forwarded whole when no preview is asked for", async () => {
  const photo = await sharp({ create: { width: 64, height: 32, channels: 3, background: "red" } })
    .jpeg()
    .toBuffer();
  const { get } = await serving(photo, "image/jpeg");

  const result = await get(`/v1/images/${hash}`);

  if (result.kind !== "response") throw new Error(result.message);
  expect(Buffer.from(result.body, "base64").equals(photo)).toBe(true);
});

test("a preview of bytes that aren't a picture is refused, never forwarded as they are", async () => {
  const { get } = await serving(Buffer.from("not an image"), "image/png");

  const result = await get(`/v1/images/${hash}?preview`);

  expect(result).toMatchObject({ kind: "response", status: 422 });
});

test("Spade's refusal of a missing picture comes back as it is", async () => {
  const { get } = await serving(Buffer.alloc(0), "image/png");

  const result = await get(`/v1/images/${"b".repeat(64)}?preview`);

  expect(result).toMatchObject({ kind: "response", status: 404 });
});

test("a HEIC picture is previewed as a PNG too, by the same decoder", async () => {
  const heic = await readFile(
    new URL("../../../../packages/context/fixtures/colours.heic", import.meta.url),
  );
  const { get } = await serving(heic, "image/heic");

  const result = await get(`/v1/images/${hash}?preview`);

  if (result.kind !== "response") throw new Error(result.message);
  const preview = await sharp(Buffer.from(result.body, "base64")).metadata();
  expect(preview).toMatchObject({ format: "png", width: 320, height: 240 });
});
