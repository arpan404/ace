import { z } from "zod";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { probeOutput, spawnSupervised } from "@ace/provider-kit/process";
import {
  InteractionEvidence,
  ScreenInventory,
  ScreenPermissions,
  ScreenUIFindResult,
} from "@ace/protocol";
import { analyzeInteraction } from "@ace/interaction";
import { Helper, HelperCommandError } from "../src/index.ts";

// Explicitly opt in: node packages/screen/bench/interaction.ts with ACE_SCREEN_INTEGRATION=1.
// Only the worktree's dedicated fixture app and a private temporary frame socket are used.
// Add --filmstrip-preview to save one private fixture JPEG under /tmp for visual inspection.
const directory = new URL("../../../native/screen-helper/", import.meta.url).pathname;
const NativeEvidence = InteractionEvidence.omit({
  source: true,
  target: true,
  action: true,
}).extend({
  hostCores: z.number().int().positive().optional(),
});
const Metrics = z.object({
  cpuMicros: z.number().nonnegative(),
  peakRssBytes: z.number().nonnegative(),
});

if (process.platform !== "darwin" || process.env.ACE_SCREEN_INTEGRATION !== "1") {
  console.log("interaction bench skipped: macOS and ACE_SCREEN_INTEGRATION=1 required");
} else {
  await benchmark();
}

async function benchmark() {
  for (const script of ["build.sh", "build-test-window.sh"]) {
    const build = await probeOutput("sh", [join(directory, script)], { timeoutMs: 120_000 });
    if (build.code !== 0) throw new Error(`${script} failed: ${build.stdout}\n${build.stderr}`);
  }
  let nextId = 0;
  const helper = await Helper.open({
    command: join(directory, "build/ace-screen-helper"),
    args: ["--inherit-responsibility"],
    nextId: () => `interaction-bench-${++nextId}`,
    onFrame: () => {},
    onFailure: () => {},
  });
  try {
    await helper.negotiate();
    const permissions = ScreenPermissions.parse(await helper.request({ op: "permissions" }));
    if (!permissions.screenRecording || !permissions.accessibility) {
      console.log(
        "interaction bench skipped: Screen Recording and Accessibility permission required",
      );
      return;
    }
    await captureFixture(helper);
  } finally {
    await helper.close();
  }
}

async function captureFixture(helper: Helper) {
  const title = "ace interaction overhead fixture";
  const app = spawnSupervised({
    command: join(directory, "build/ScreenTest.app/Contents/MacOS/ScreenTest"),
    args: [title, "--smoothness-smooth", "-ApplePersistenceIgnoreState", "YES"],
    name: "interaction-overhead-fixture",
    env: {},
  });
  const ready = new Promise<void>((resolve, reject) => {
    app.stdout.on("line", (line: string) => {
      if (line === "ready") resolve();
    });
    void app.exited.then(() => reject(new Error("Fixture exited before becoming ready")));
  });
  let selected = false;
  try {
    await ready;
    const inventory = ScreenInventory.parse(await helper.request({ op: "targets" }));
    const window = inventory.windows.find(
      (candidate) => candidate.bundleId === "dev.ace.screen-test" && candidate.title === title,
    );
    if (!window?.bounds) throw new Error("Fixture window is not visible to ScreenCaptureKit");
    const target = {
      kind: "window",
      bundleId: "dev.ace.screen-test",
      windowId: window.windowId,
    } as const;
    await helper.request({
      op: "start",
      sessionId: "interaction-overhead",
      target,
      fps: 10,
      capture: false,
      allowlist: [target.bundleId],
      mode: "background",
    });
    selected = true;
    const buttons = ScreenUIFindResult.parse(
      await helper.request({
        op: "ui.find",
        target,
        allowlist: [target.bundleId],
        query: { role: "AXButton", name: "Click test" },
        limit: 1,
      }),
    );
    const button = buttons.nodes[0];
    if (!button) throw new Error("Fixture's click action is not accessible");
    const action = {
      kind: "pointer.click",
      x: button.bounds.x + button.bounds.w / 2 - window.bounds.x,
      y: button.bounds.y + button.bounds.h / 2 - window.bounds.y,
      button: "left",
    } as const;
    let filmstripPreview: string | undefined;
    for (const filmstrip of [false, true]) {
      for (let run = 1; run <= 3; run++) {
        const before = Metrics.parse(await helper.request({ op: "metrics" }));
        const started = performance.now();
        const raw = NativeEvidence.parse(
          await helper.request({
            op: "measure_interaction",
            action,
            observeMs: 2000,
            filmstrip,
          }),
        );
        const elapsedMs = performance.now() - started;
        const after = Metrics.parse(await helper.request({ op: "metrics" }));
        const { hostCores, ...evidence } = raw;
        const measurement = analyzeInteraction({
          ...evidence,
          source: "screen-frames",
          target,
          ...(hostCores === undefined ? {} : { cores: hostCores }),
        });
        if (
          measurement.filmstrip &&
          !filmstripPreview &&
          process.argv.includes("--filmstrip-preview")
        ) {
          const previewDirectory = await mkdtemp("/tmp/ace-interaction-preview-");
          filmstripPreview = join(previewDirectory, "filmstrip.jpg");
          await writeFile(filmstripPreview, Buffer.from(measurement.filmstrip.data, "base64"), {
            mode: 0o600,
          });
        }
        console.log(
          JSON.stringify({
            name: "display-rate fixture-window measurement",
            filmstrip,
            run,
            elapsedMs: Number(elapsedMs.toFixed(2)),
            recordedMs: measurement.windowMs,
            refreshHz: measurement.refreshHz,
            updates: measurement.frames,
            captureOverheadPct: measurement.captureOverheadPct,
            helperCpuPct: Number(
              ((after.cpuMicros - before.cpuMicros) / (elapsedMs * 10)).toFixed(2),
            ),
            helperPeakRssMiB: Number((after.peakRssBytes / (1024 * 1024)).toFixed(2)),
            filmstripBytes: measurement.filmstrip
              ? Buffer.from(measurement.filmstrip.data, "base64").length
              : 0,
            filmstripPreview,
            hostLoad: measurement.hostLoad,
            hostCores,
            verdict: measurement.verdict,
            confidence: measurement.confidence,
            notes: measurement.notes,
          }),
        );
      }
    }
  } catch (error) {
    if (error instanceof HelperCommandError && error.code === "focus_changed") {
      console.log(`interaction bench interrupted: ${error.message}`);
    } else if (
      error instanceof Error &&
      /desktop may be locked|Screen Recording permission denied/i.test(error.message)
    ) {
      console.log(`interaction bench skipped: ${error.message}`);
    } else {
      throw error;
    }
  } finally {
    try {
      if (selected) await helper.request({ op: "stop" });
    } finally {
      await app.stop({ graceMs: 0 });
    }
  }
}
