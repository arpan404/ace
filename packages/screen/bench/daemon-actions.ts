import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ScreenManager } from "../src/index.ts";
import { computerUseHandler } from "../src/tools.ts";
const module = process.env.BASELINE_SCREEN
  ? await import(pathToFileURL(join(process.env.BASELINE_SCREEN, "index.ts")).href)
  : { ScreenManager, computerUseHandler };
const root = await mkdtemp(join(tmpdir(), "ace-screen-bench-"));
let id = 0;
const screen = new module.ScreenManager({
  command: process.execPath,
  args: [new URL("../src/testing/fake-helper-behavior.ts", import.meta.url).pathname],
  env: { REQUEST_DELAY_MS: "10" },
  nextId: () => `bench-${++id}`,
  recordingDirectory: root,
  publishArtifact: async () => {},
});
try {
  await screen.enable(true);
  await screen.approve("dev.ace.test", true);
  const state = await screen.start({ kind: "window", bundleId: "dev.ace.test", windowId: 2 });
  screen.controller(state.sessionId, "agent", "agent");
  const tools = module.computerUseHandler(screen, state.sessionId, "agent");
  const results: Record<string, number> = {};
  for (const [name, args] of [
    ["screen_key", { key: "l", modifiers: ["command"] }],
    ["screen_type", { text: "fixture" }],
    ["screen_click", { x: 10, y: 10 }],
    ["screen_scroll", { dx: 0, dy: 10 }],
    ["screen_paste", { text: "fixture" }],
  ] as const) {
    const samples: number[] = [];
    for (let repeat = 0; repeat < 10; repeat++) {
      const started = performance.now();
      await tools(name, args);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    results[name] = Number((samples[5] ?? 0).toFixed(2));
  }
  console.log(JSON.stringify({ fixtureRoundTripMs: 10, samplesPerAction: 10, medianMs: results }));
} finally {
  await screen.close();
  await rm(root, { recursive: true, force: true });
}
