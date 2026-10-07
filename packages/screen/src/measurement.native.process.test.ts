import { z } from "zod";
import { once } from "node:events";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { probeOutput, spawnSupervised } from "@ace/provider-kit/process";
import {
  InteractionEvidence,
  ScreenInventory,
  ScreenPermissions,
  ScreenUIFindResult,
  type ScreenInput,
} from "@ace/protocol";
import { analyzeInteraction } from "@ace/interaction";
import { Helper } from "./index.ts";
import { ids } from "./testing/support.ts";

const directory = new URL("../../../native/screen-helper/", import.meta.url).pathname;
const NativeEvidence = InteractionEvidence.omit({
  source: true,
  target: true,
  action: true,
}).extend({
  hostCores: z.number().int().positive().optional(),
});

describe.skipIf(process.platform !== "darwin" || process.env.ACE_SCREEN_INTEGRATION !== "1")(
  "opt-in measurement of a dedicated macOS fixture",
  () => {
    let helper: Helper | undefined;
    let permissions: ScreenPermissions | undefined;

    beforeAll(async () => {
      for (const script of ["build.sh", "build-test-window.sh"]) {
        const build = await probeOutput("sh", [join(directory, script)], { timeoutMs: 120_000 });
        if (build.code !== 0) throw new Error(`${script} failed: ${build.stdout}\n${build.stderr}`);
      }
      helper = await Helper.open({
        command: join(directory, "build/ace-screen-helper"),
        args: ["--inherit-responsibility"],
        nextId: ids(),
        onFrame: () => {},
        onFailure: () => {},
      });
      await helper.negotiate();
      permissions = ScreenPermissions.parse(await helper.request({ op: "permissions" }));
    }, 180_000);

    afterAll(async () => {
      await helper?.close();
    });

    it("reports a smooth animation when the host has spare CPU capacity", async (context) => {
      const skip = permissionSkip(permissions);
      if (skip) return context.skip(skip);
      if (!helper) throw new Error("Native helper did not start");
      try {
        const smooth = await measureFixture(helper, "--smoothness-smooth", false);
        if (smooth.hostLoad === undefined || smooth.hostCores === undefined)
          return context.skip("Host load or logical core count is unavailable");
        if (smooth.hostLoad > smooth.hostCores)
          return context.skip(
            `Host one-minute load ${smooth.hostLoad} exceeds ${smooth.hostCores} logical cores`,
          );
        expect(smooth.measurement.verdict, JSON.stringify(smooth.measurement)).toBe("smooth");
      } catch (error) {
        if (captureUnavailable(error)) return context.skip(error.message);
        throw error;
      }
    }, 60_000);

    it("reports the fixture's injected 120 ms stall as janky", async (context) => {
      const skip = permissionSkip(permissions);
      if (skip) return context.skip(skip);
      if (!helper) throw new Error("Native helper did not start");
      try {
        const stalled = await measureFixture(helper, "--smoothness-stall", true);
        expect(stalled.measurement.verdict).toBe("janky");
        expect(stalled.events).toContain("stall");
        expect(stalled.events).toContain("settled");
        const hitch = stalled.measurement.hitches.find(
          (gap) => gap.atMs >= 300 && gap.atMs <= 500 && gap.durationMs >= 90,
        );
        expect(hitch).toBeDefined();
        expect(hitch?.durationMs).toBeLessThan(200);
        expect(stalled.measurement.hitchRatioMsPerS).toBeGreaterThan(10);
        expect(stalled.measurement.droppedFrames).toBeGreaterThan(0);
        expect(stalled.measurement.settleMs).toBeGreaterThan(900);
        expect(stalled.measurement.settleMs).toBeLessThan(1300);
        const filmstrip = stalled.measurement.filmstrip;
        if (!filmstrip) throw new Error("Animated measurement did not return its filmstrip");
        const decoder = spawnSupervised({
          command: join(directory, "build/inspect-jpeg"),
          name: "interaction-filmstrip-inspection",
          env: {},
        });
        try {
          const output = once(decoder.stdout, "line");
          const exitedBeforeOutput = decoder.exited.then(() => {
            throw new Error("Filmstrip decoder exited before emitting decoded pixels");
          });
          decoder.stdin.end(Buffer.from(filmstrip.data, "base64"));
          const colors = z
            .object({
              red: z.number().nonnegative(),
              blue: z.number().nonnegative(),
              samples: z.number().positive(),
            })
            .parse(JSON.parse((await Promise.race([output, exitedBeforeOutput]))[0]));
          expect((await decoder.exited).code).toBe(0);
          expect(colors.red / colors.samples).toBeGreaterThan(0.001);
          expect(colors.blue / colors.samples).toBeGreaterThan(0.001);
        } finally {
          await decoder.stop({ graceMs: 0 });
        }
      } catch (error) {
        if (captureUnavailable(error)) return context.skip(error.message);
        throw error;
      }
    }, 60_000);

    it("measures the fixture's delayed click response on the capture clock", async (context) => {
      const skip = permissionSkip(permissions);
      if (skip) return context.skip(skip);
      if (!helper) throw new Error("Native helper did not start");
      try {
        const response = await measureFixture(helper, "--smoothness-latency", false);
        expect(response.events).toContain("clicked");
        expect(response.events).toContain("response");
        expect(response.measurement.latencyMs).toBeGreaterThanOrEqual(150);
        expect(response.measurement.latencyMs).toBeLessThan(260);
        expect(response.measurement.settleMs).toBeGreaterThanOrEqual(150);
        expect(response.measurement.frames).toBeGreaterThan(0);
      } catch (error) {
        if (captureUnavailable(error)) return context.skip(error.message);
        throw error;
      }
    }, 60_000);

    it("caps capture while preserving a delayed click's measured latency", async (context) => {
      const skip = permissionSkip(permissions);
      if (skip) return context.skip(skip);
      if (!helper) throw new Error("Native helper did not start");
      try {
        const response = await measureFixture(helper, "--smoothness-latency", false, 500);
        expect(response.events).toContain("response");
        expect(response.measurement.windowMs).toBeLessThanOrEqual(500);
        expect(response.measurement.latencyMs).toBeGreaterThanOrEqual(150);
        expect(response.measurement.latencyMs).toBeLessThan(260);
        expect(response.truncated).toBe(true);
        expect(response.measurement.verdict).toBe("inconclusive");
      } catch (error) {
        if (captureUnavailable(error)) return context.skip(error.message);
        throw error;
      }
    }, 60_000);
  },
);

function permissionSkip(permissions: ScreenPermissions | undefined): string | undefined {
  if (!permissions) throw new Error("Native permission inspection did not complete");
  if (!permissions.screenRecording) return "Screen Recording permission has not been granted";
  if (!permissions.accessibility) return "Accessibility permission has not been granted";
  return undefined;
}

function captureUnavailable(error: unknown): error is Error {
  return (
    error instanceof Error &&
    /desktop may be locked|Screen Recording permission denied/i.test(error.message)
  );
}

async function measureFixture(
  helper: Helper,
  mode: string,
  filmstrip: boolean,
  maxWindowMs?: number,
) {
  const title = `ace interaction ${mode.slice("--smoothness-".length)}`;
  const app = spawnSupervised({
    command: join(directory, "build/ScreenTest.app/Contents/MacOS/ScreenTest"),
    name: "interaction-fixture-window",
    args: [title, mode, "-ApplePersistenceIgnoreState", "YES"],
    env: {},
  });
  const events: string[] = [];
  const fixtureEvents = new Set(["ready", "clicked", "response", "stall", "settled"]);
  const ready = new Promise<void>((resolve, reject) => {
    app.stdout.on("line", (line: string) => {
      if (fixtureEvents.has(line) && events.length < 16) events.push(line);
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
      sessionId: "interaction-fixture",
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
    const action: ScreenInput = {
      kind: "pointer.click",
      x: button.bounds.x + button.bounds.w / 2 - window.bounds.x,
      y: button.bounds.y + button.bounds.h / 2 - window.bounds.y,
      button: "left",
    };
    const raw = NativeEvidence.parse(
      await helper.request({
        op: "measure_interaction",
        observeMs: 2000,
        filmstrip,
        action,
        ...(maxWindowMs === undefined ? {} : { maxWindowMs }),
      }),
    );
    const { hostCores, ...evidence } = raw;
    const measurement = analyzeInteraction({
      ...evidence,
      source: "screen-frames",
      target,
      action,
      ...(hostCores === undefined ? {} : { cores: hostCores }),
    });
    return { measurement, events, hostLoad: raw.hostLoad, hostCores, truncated: raw.truncated };
  } finally {
    try {
      if (selected) await helper.request({ op: "stop" });
    } finally {
      await app.stop({ graceMs: 0 });
    }
  }
}
