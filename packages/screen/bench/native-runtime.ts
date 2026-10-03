/** Non-gating macOS benchmark. Not executed under the owner rule; needs run at merge. */
import { z } from "zod";
import { performance } from "node:perf_hooks";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { spawnSupervised } from "@ace/provider-kit/process";
import { ScreenInventory, ScreenUITreeResult } from "@ace/protocol";
import { Helper } from "../src/index.ts";
const Settings = z.object({
  helper: z.string().min(1),
  fixture: z.string().min(1),
  bundle: z.string().min(1).max(256).default("com.apple.finder"),
});
const settings = Settings.parse({
  helper: process.env.ACE_SCREEN_BENCH_HELPER,
  fixture: process.env.ACE_SCREEN_BENCH_FIXTURE,
  bundle: process.env.ACE_SCREEN_BENCH_BUNDLE,
});
if (process.platform !== "darwin") throw new Error("Requires macOS; no platform fallback probe");
const Metrics = z.object({
  cpuMicros: z.number().nonnegative(),
  peakRssBytes: z.number().nonnegative(),
  encodedFrames: z.number().int().nonnegative(),
  encodeNanos: z.number().nonnegative(),
});
const fixture = spawnSupervised({
  command: settings.fixture,
  args: ["ace benchmark", "--animate", "-ApplePersistenceIgnoreState", "YES"],
  env: {},
  name: "owned-benchmark-window",
});
let frames = 0;
const helper = await Helper.open({
  command: settings.helper,
  nextId: randomUUID,
  onFrame: () => {
    frames++;
  },
  onFailure: () => {},
}).catch(async (error: unknown) => {
  await fixture.stop({ graceMs: 0 });
  throw error;
});
try {
  await once(fixture.stdout, "line");
  await helper.negotiate();
  const content = ScreenInventory.parse(await helper.request({ op: "targets" }));
  const window = content.windows.find((candidate) => candidate.title === "ace benchmark");
  if (!window) throw new Error("Owned benchmark window not found");
  await helper.request({
    op: "start",
    sessionId: "bench",
    target: { kind: "window", windowId: window.windowId, bundleId: window.bundleId },
    allowlist: [window.bundleId],
    fps: 10,
    capture: false,
  });
  const sample = async () => Metrics.parse(await helper.request({ op: "metrics" }));
  for (const capture of [false, true]) {
    await helper.request({ op: "capture", enabled: capture });
    const before = await sample(),
      start = performance.now(),
      received = frames;
    // A sampling interval is instrumentation, never a gating performance threshold.
    await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
    const elapsed = performance.now() - start,
      after = await sample();
    const encoded = after.encodedFrames - before.encodedFrames;
    console.log(
      JSON.stringify({
        phase: capture ? "changing window 10fps" : "idle (no pixel consumers)",
        cpuPercent: (after.cpuMicros - before.cpuMicros) / (elapsed * 10),
        frames: frames - received,
        encodedFrames: encoded,
        meanEncodeUs:
          encoded === 0 ? null : (after.encodeNanos - before.encodeNanos) / encoded / 1000,
        peakRssMiB: after.peakRssBytes / 1024 / 1024,
      }),
    );
  }
  await helper.request({ op: "capture", enabled: false });
  const display = content.displays[0];
  if (!display) throw new Error("No display");
  for (const phase of ["cold", "cached"]) {
    const times: number[] = [];
    let nodes = 0;
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      const tree = ScreenUITreeResult.parse(
        await helper.request({
          op: "ui.tree",
          target: { kind: "app", bundleId: settings.bundle, displayId: display.displayId },
          allowlist: [settings.bundle],
          maxDepth: 16,
          // Alternate caps to invalidate the single cached snapshot without polling or sleep.
          maxNodes: phase === "cold" ? 511 + (i % 2) : 512,
        }),
      );
      times.push(performance.now() - start);
      nodes = 0;
      const pending = [...tree.nodes];
      while (pending.length) {
        const node = pending.pop();
        if (node) {
          nodes++;
          pending.push(...node.children);
        }
      }
    }
    times.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        phase: `large app ui.tree (${phase}, bounded)`,
        bundle: settings.bundle,
        medianMs: times[15],
        p95Ms: times[28],
        nodes,
        peakRssMiB: (await sample()).peakRssBytes / 1024 / 1024,
      }),
    );
  }
} finally {
  await helper.close();
  await fixture.stop({ graceMs: 0 });
}
