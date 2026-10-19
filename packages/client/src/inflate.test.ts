import { deflateRawSync } from "node:zlib";
import { expect, it } from "vitest";
import { inflateRaw } from "./inflate.ts";

const text = '{"type":"browser.state","tabs":[' + '{"url":"https://example.com"},'.repeat(4000);

it("a deflated relay message inflates to the daemon's exact bytes", async () => {
  const original = new TextEncoder().encode(text);
  const inflated = await inflateRaw(deflateRawSync(original), 16 * 1024 * 1024);
  expect(new TextDecoder().decode(inflated)).toBe(text);
});

it("a small message that would inflate past the limit is refused", async () => {
  const bomb = deflateRawSync(new Uint8Array(4 * 1024 * 1024));
  expect(bomb.length).toBeLessThan(16 * 1024);
  await expect(inflateRaw(bomb, 1024 * 1024)).rejects.toThrow("Relay message limit");
});

it("a corrupt message is refused", async () => {
  await expect(inflateRaw(new Uint8Array([0xff, 0xff, 0xff, 0x00]), 1024)).rejects.toThrow();
});
