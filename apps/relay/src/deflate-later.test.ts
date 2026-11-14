import { expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { deflateLater } from "./channel.ts";

// The channel's own deflate for large messages, not an injected one: it must leave the event
// loop free while it works.

/** Transcript-like JSON of about `bytes`: repetitive, so it deflates well but takes a while. */
function transcript(bytes: number): Uint8Array {
  const items = Array.from({ length: Math.ceil(bytes / 52) }, (_, index) => ({
    id: `item-${index}`,
    text: `line ${index} of output ${index % 97}`,
  }));
  return new TextEncoder().encode(JSON.stringify(items));
}

it("the production deflate lets the event loop turn many times before its result arrives", async () => {
  const json = transcript(8 * 1024 * 1024);
  let turns = 0;
  let counting = true;
  const tick = () => {
    if (!counting) return;
    turns++;
    setImmediate(tick);
  };
  setImmediate(tick);
  // Deflating 8 MiB takes tens of milliseconds on a worker. On the event loop (even inside a
  // promise) no turn could happen until it was done; a loaded machine may delay the loop, so
  // only one turn is required.
  const deflated = await deflateLater(json);
  counting = false;
  expect(turns).toBeGreaterThanOrEqual(1);
  // Compared as bytes in one call: a deep equality over 8 MiB would take seconds.
  expect(Buffer.compare(inflateRawSync(deflated), json)).toBe(0);
});
