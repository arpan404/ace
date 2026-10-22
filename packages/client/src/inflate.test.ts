import { deflateRawSync, gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { canInflate, inflate, InflateLimitError, relayCompression } from "./inflate.ts";

const text = '{"type":"browser.state","tabs":[' + '{"url":"https://example.com"},'.repeat(4000);
afterEach(() => vi.unstubAllGlobals());

it("a deflated relay message inflates to the daemon's exact bytes", async () => {
  const original = new TextEncoder().encode(text);
  const inflated = await inflate("deflate-raw", deflateRawSync(original), 16 * 1024 * 1024);
  expect(new TextDecoder().decode(inflated)).toBe(text);
});

it("a gzipped file part inflates to the file's exact bytes", async () => {
  const original = new TextEncoder().encode(text);
  const inflated = await inflate("gzip", gzipSync(original), original.length);
  expect(new TextDecoder().decode(inflated)).toBe(text);
});

it("a small message that would inflate past the limit is refused", async () => {
  const bomb = deflateRawSync(new Uint8Array(4 * 1024 * 1024));
  expect(bomb.length).toBeLessThan(16 * 1024);
  await expect(inflate("deflate-raw", bomb, 1024 * 1024)).rejects.toThrow(InflateLimitError);
});

it("a corrupt message is refused", async () => {
  await expect(
    inflate("deflate-raw", new Uint8Array([0xff, 0xff, 0xff, 0x00]), 1024),
  ).rejects.toThrow();
  await expect(inflate("gzip", new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0]), 1024)).rejects.toThrow();
});

it("a platform without a decompressor asks the relay for no compression", () => {
  expect(relayCompression()).toEqual(["deflate-raw"]);
  vi.stubGlobal("DecompressionStream", undefined);
  expect(canInflate()).toBe(false);
  expect(relayCompression()).toEqual([]);
});
