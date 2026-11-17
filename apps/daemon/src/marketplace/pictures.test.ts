import { sha256Hex } from "@ace/marketplace";
import { expect, test } from "vitest";
import { MarketHttp } from "./http.ts";
import { MarketPictures, PictureRefused } from "./pictures.ts";

/* Listing pictures reach the app only as the bytes their sha256 names, and only as images. */

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function market(served: Record<string, Uint8Array>) {
  const asked: string[] = [];
  const http = new MarketHttp({
    origin: "http://127.0.0.1:1",
    fetch: async (url) => {
      asked.push(new URL(url).pathname);
      const bytes = served[new URL(url).pathname];
      return bytes ? new Response(new Uint8Array(bytes)) : new Response("", { status: 404 });
    },
  });
  return { http, asked };
}

test("a listing picture is answered as base64 with its type, and read once for many cards", async () => {
  const hash = sha256Hex(png);
  const { http, asked } = market({ [`/v1/previews/${hash}`]: png });
  const pictures = new MarketPictures();

  const first = await pictures.read(http, "preview", hash);
  const again = await pictures.read(http, "preview", hash);

  expect(first).toEqual({
    op: "picture",
    type: "image/png",
    data: Buffer.from(png).toString("base64"),
  });
  expect(again).toEqual(first);
  expect(asked).toEqual([`/v1/previews/${hash}`]);
});

test("bytes that don't hash to the name asked for are refused", async () => {
  const hash = "a".repeat(64);
  const { http } = market({ [`/v1/avatars/${hash}`]: png });
  await expect(new MarketPictures().read(http, "avatar", hash)).rejects.toBeInstanceOf(
    PictureRefused,
  );
});

test("bytes that aren't a PNG, JPEG or WebP are refused", async () => {
  const text = new TextEncoder().encode("<svg onload=alert(1)>");
  const hash = sha256Hex(text);
  const { http } = market({ [`/v1/previews/${hash}`]: text });
  await expect(new MarketPictures().read(http, "preview", hash)).rejects.toThrow(
    "isn't a PNG, JPEG or WebP",
  );
});
