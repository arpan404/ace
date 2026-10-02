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
    const f = await fixture({ now: () => (clock += 100) });
    await f.navigate();
    let batch: BrowserFrame[] = [];
    let target = 8;
    let signal = Promise.withResolvers<void>();
    const stopFast = f.service.subscribe(
      "thread",
      "fast",
      {
        send(frame) {
          batch.push(frame);
          f.service.acknowledge("thread", "fast", frame.sequence);
          if (batch.length >= target) signal.resolve();
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
    batch = [];
    target = 32;
    signal = Promise.withResolvers<void>();
    const stopSlow = f.service.subscribe("thread", "slow", { send: () => true }, () => {});
    await signal.promise;
    const pressured = batch.slice(-8);
    expect(pressured.every((frame) => quantization(frame) > quantization(normal))).toBe(true);
    const gaps = pressured
      .slice(1)
      .map((frame, i) => frame.timestamp - (pressured[i]?.timestamp ?? 0));
    expect(gaps.every((gap) => gap >= 1000 / 6)).toBe(true);
    stopSlow();
    batch = [];
    target = 48;
    signal = Promise.withResolvers<void>();
    await signal.promise;
    expect(batch.slice(-8).every((frame) => quantization(frame) === quantization(normal))).toBe(
      true,
    );
    await f.evaluate("window.animate=false");
    stopFast();
  }, 30_000);
});
