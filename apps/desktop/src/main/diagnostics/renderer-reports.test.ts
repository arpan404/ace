import { describe, expect, it } from "vitest";
import { createDesktopLog } from "../log/desktop-log.ts";
import { createDesktopRedactor } from "../log/redact.ts";
import { rendererReports } from "./renderer-reports.ts";

/** Renderer reports through the real desktop log, with a clock the test moves. */
function reports(options: { burst?: number; refillMs?: number } = {}) {
  let now = 0;
  const written: string[] = [];
  const log = createDesktopLog({
    now: () => now,
    console: (_level, text) => written.push(text),
    redact: createDesktopRedactor({ env: {} }),
  })("renderer");
  const report = rendererReports({ log, now: () => now, ...options });
  return {
    report,
    written,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("renderer diagnostics in the desktop log", () => {
  it("writes a page's report under the renderer component", () => {
    const { report, written } = reports();
    expect(
      report({
        event: "worker.unresponsive",
        data: { waitedMs: 5_000, port: "shared", ok: false },
      }),
    ).toBe(true);
    expect(written).toEqual([
      '[info] renderer: worker.unresponsive {"waitedMs":5000,"port":"shared","ok":false}',
    ]);
  });

  it("rejects an oversized or malformed report without logging it", () => {
    const { report, written } = reports();
    const tooManyFields = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [`f${index}`, index]),
    );
    for (const payload of [
      { event: "x".repeat(129) },
      { event: "big", data: { detail: "x".repeat(1_025) } },
      { event: "wide", data: tooManyFields },
      { event: "nested", data: { error: { message: "no" } } },
      { event: "" },
      { event: "extra", level: "error" },
      "worker.unresponsive",
      null,
    ])
      expect(report(payload)).toBe(false);
    expect(written).toEqual([]);
  });

  it("rate-limits a burst of reports, then says how many it dropped", () => {
    const { report, written, advance } = reports({ burst: 3, refillMs: 1_000 });
    const results = Array.from({ length: 10 }, (_, index) =>
      report({ event: "loop", data: { index } }),
    );
    expect(results).toEqual([true, true, true, false, false, false, false, false, false, false]);
    expect(written).toEqual([
      '[info] renderer: loop {"index":0}',
      '[info] renderer: loop {"index":1}',
      '[info] renderer: loop {"index":2}',
      "[warn] renderer: Renderer diagnostics are arriving too fast; dropping them for now",
    ]);
    advance(999);
    expect(report({ event: "loop", data: { index: 10 } })).toBe(false);
    advance(1);
    expect(report({ event: "loop", data: { index: 11 } })).toBe(true);
    expect(written.at(-1)).toBe('[info] renderer: loop {"index":11,"droppedBefore":8}');
  });

  it("allows a full burst again after a long quiet spell, but no more", () => {
    const { report, written, advance } = reports({ burst: 2, refillMs: 1_000 });
    report({ event: "a" });
    report({ event: "b" });
    advance(60_000);
    expect([report({ event: "c" }), report({ event: "d" }), report({ event: "e" })]).toEqual([
      true,
      true,
      false,
    ]);
    expect(written.filter((line) => line.startsWith("[info]"))).toHaveLength(4);
  });
});
