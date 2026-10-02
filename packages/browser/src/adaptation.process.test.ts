import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import type { BrowserFrame } from "@ace/protocol";
import { executablePath, fixture } from "./test-support.ts";

// Read the encoded JPEG's first quantization coefficient. Larger values mean
// more compression; this measures actual Chrome output, not settings constants.
function quantization(frame: BrowserFrame): number {
  const jpeg = Buffer.from(frame.data, "base64");
  for (let offset = 2; offset + 5 < jpeg.length;) {
    if (jpeg[offset] !== 255) throw new Error("Invalid JPEG marker");
    if (jpeg[offset + 1] === 219) return jpeg.readUInt8(offset + 5);
    const length = jpeg.readUInt16BE(offset + 2);
    if (length < 2) throw new Error("Invalid JPEG segment");
    offset += length + 2;
  }
  throw new Error("JPEG has no quantization table");
}

describe.skipIf(!executablePath)("capture adaptation in real Chromium", () => {
  it("reduces encoded JPEG quality and delivered frame cadence under pressure and recovers", async () => {
    let clock = 0;
    const f = await fixture({
      now: () => clock,
      launchContext: async (profile, options) => {
        const context = await chromium.launchPersistentContext(profile, options);
        const createSession = context.newCDPSession.bind(context);
        context.newCDPSession = async (page) => {
          const session = await createSession(page);
          // Advance only on incoming Chrome frames, before capture receives them.
          // Interval clock reads cannot fabricate gaps in delivered timestamps.
          session.on("Page.screencastFrame", () => {
            clock += 100;
          });
          return session;
        };
        return context;
      },
    });
    await f.navigate();
    let phase: "baseline" | "pressure" | "recovery" = "baseline";
    let normalQuality = 0;
    let batch: BrowserFrame[] = [];
    let signal = Promise.withResolvers<void>();
    const stopFast = f.service.subscribe(
      "thread",
      "fast",
      {
        send(frame) {
          const quality = quantization(frame);
          const matches =
            phase === "baseline" ||
            (phase === "pressure" ? quality > normalQuality : quality === normalQuality);
          if (matches) {
            batch.push(frame);
            if (batch.length > 8) batch.shift();
            if (batch.length >= (phase === "baseline" ? 2 : 8)) signal.resolve();
          } else batch = [];
          f.service.acknowledge("thread", "fast", frame.sequence);
          return true;
        },
      },
      () => {},
    );
    await f.evaluate(
      "window.animate=true;let tick=0;function paint(){if(!window.animate)return;document.body.style.background=`rgb(${++tick%255},30,80)`;requestAnimationFrame(paint)}paint()",
    );
    await signal.promise;
    const normal = batch.at(-1);
    if (!normal) throw new Error("No baseline frame");
    normalQuality = quantization(normal);
    phase = "pressure";
    batch = [];
    signal = Promise.withResolvers<void>();
    const stopSlow = f.service.subscribe("thread", "slow", { send: () => true }, () => {});
    // Eight consecutive frames encoded at reduced quality prove adaptation has
    // happened, rather than guessing how many frames the interval will need.
    await signal.promise;
    expect(batch).toHaveLength(8);
    expect(batch.every((frame) => quantization(frame) > normalQuality)).toBe(true);
    const gaps = batch.slice(1).map((frame, i) => frame.timestamp - (batch[i]?.timestamp ?? 0));
    expect(gaps.every((gap) => gap >= 1000 / 6)).toBe(true);
    phase = "recovery";
    batch = [];
    signal = Promise.withResolvers<void>();
    stopSlow();
    await signal.promise;
    expect(batch).toHaveLength(8);
    expect(batch.every((frame) => quantization(frame) === normalQuality)).toBe(true);
    await f.evaluate("window.animate=false");
    stopFast();
  }, 60_000);
});
