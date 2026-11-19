import { z } from "zod";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { probeOutput, spawnSupervised } from "@ace/provider-kit/process";
import { ScreenInventory, ScreenPermissions } from "@ace/protocol";
import { ScreenTarget, ScreenUIActResult, ScreenUIFindResult, ScreenUITree } from "@ace/protocol";
import { Helper, type Frame } from "./index.ts";
import { nativeWindowsHelper, ownedWindow } from "./testing/owned-window.ts";
import { deferred, ids } from "./testing/support.ts";
const directory = new URL("../../../native/screen-helper/", import.meta.url).pathname;
it.skipIf(process.platform !== "darwin" || process.env.ACE_SCREEN_INTEGRATION !== "1")(
  "macOS captures JPEG frames from a dedicated approved test window",
  async (context) => {
    expect(
      (await probeOutput("sh", [join(directory, "build.sh")], { timeoutMs: 120_000 })).code,
    ).toBe(0);
    const received = deferred<Frame>();
    const appReceived = deferred<Frame>();
    const helper = await Helper.open({
      command: join(directory, "build/ace-screen-helper"),
      // Opt-in runs use the grants of the terminal that runs them, as before the helper
      // disclaimed its launcher.
      args: ["--inherit-responsibility"],
      nextId: ids(),
      onFrame: (frame) =>
        frame.header.sessionId === "native-app"
          ? appReceived.resolve(frame)
          : received.resolve(frame),
      onFailure: () => {},
    });
    onTestFinished(async () => {
      await helper.close();
    });
    try {
      const permissions = ScreenPermissions.parse(await helper.request({ op: "permissions" }));
      if (!permissions.screenRecording) {
        context.skip("Screen Recording permission has not been granted");
        return;
      }
      expect(
        (await probeOutput("sh", [join(directory, "build-test-window.sh")], { timeoutMs: 120_000 }))
          .code,
      ).toBe(0);
      const app = spawnSupervised({
        command: join(directory, "build/ScreenTest.app/Contents/MacOS/ScreenTest"),
        name: "screen-test-window",
        args: ["ace screen integration", "-ApplePersistenceIgnoreState", "YES"],
        env: {},
      });
      onTestFinished(async () => {
        await app.stop({ graceMs: 0 });
      });
      try {
        await once(app.stdout, "line");
        const content = ScreenInventory.parse(await helper.request({ op: "targets" }));
        const window = content.windows.find(
          (candidate) =>
            candidate.bundleId === "dev.ace.screen-test" &&
            candidate.title === "ace screen integration",
        );
        if (!window?.bounds)
          throw new Error("Test window bounds are not visible to ScreenCaptureKit");
        const windowBounds = window.bounds;
        await expect(
          helper.request({
            op: "start",
            sessionId: "native",
            target: { kind: "window", bundleId: "dev.ace.screen-test", windowId: window.windowId },
            fps: 10,
            allowlist: [],
          }),
        ).rejects.toThrow("approved");
        await helper.request({
          op: "start",
          sessionId: "native",
          target: { kind: "window", bundleId: "dev.ace.screen-test", windowId: window.windowId },
          fps: 10,
          allowlist: ["dev.ace.screen-test"],
        });
        const frame = await received.promise;
        expect(frame.payload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
        expect(frame.header.width).toBeGreaterThan(0);
        expect(frame.header.height).toBeGreaterThan(0);
        const inspect = spawnSupervised({
          command: join(directory, "build/inspect-jpeg"),
          name: "jpeg-inspection",
          env: {},
        });
        const pixels = once(inspect.stdout, "line");
        inspect.stdin.end(frame.payload);
        const colors = z
          .object({ red: z.number(), blue: z.number(), samples: z.number().positive() })
          .parse(JSON.parse((await pixels)[0]));
        expect((await inspect.exited).code).toBe(0);
        expect(colors.red / colors.samples).toBeGreaterThan(0.01);
        expect(colors.blue / colors.samples).toBeGreaterThan(0.01);
        if (permissions.accessibility) {
          const overlay = spawnSupervised({
            command: join(directory, "build/ScreenTest.app/Contents/MacOS/ScreenTest"),
            name: "screen-overlap-fixture",
            env: {},
            args: ["ace overlapping window", "-ApplePersistenceIgnoreState", "YES"],
          });
          onTestFinished(async () => {
            await overlay.stop({ graceMs: 0 });
          });
          try {
            await once(overlay.stdout, "line");
            await expect(
              helper.request({
                op: "action",
                action: { kind: "click", x: 120, y: windowBounds.height - 46, button: "left" },
              }),
            ).rejects.toThrow("overlaps");
          } finally {
            await overlay.stop({ graceMs: 0 });
          }
          for (let inspection = 0; inspection < 32; inspection++) {
            const inventory = ScreenInventory.parse(await helper.request({ op: "targets" }));
            if (
              !inventory.windows.some((candidate) => candidate.title === "ace overlapping window")
            )
              break;
            if (inspection === 31)
              throw new Error("Closed overlap remains visible to ScreenCaptureKit");
          }
          const clickedWindow = once(app.stdout, "line");
          await helper.request({
            op: "action",
            action: {
              kind: "click",
              x: (frame.header.width * 120) / 400,
              y: (frame.header.height * (windowBounds.height - 46)) / windowBounds.height,
              button: "left",
            },
          });
          expect((await clickedWindow)[0]).toBe("clicked");
          const scrolledWindow = once(app.stdout, "line");
          await helper.request({
            op: "action",
            action: {
              kind: "scroll",
              x: (frame.header.width * 280) / 400,
              y: (frame.header.height * (windowBounds.height - 60)) / windowBounds.height,
              deltaX: 0,
              deltaY: -100,
            },
          });
          expect((await scrolledWindow)[0]).toBe("scrolled");
        }

        await helper.request({ op: "stop" });
        const display = content.displays.find(
          (candidate) =>
            candidate.bounds &&
            windowBounds &&
            windowBounds.x >= candidate.bounds.x &&
            windowBounds.y >= candidate.bounds.y &&
            windowBounds.x < candidate.bounds.x + candidate.bounds.width &&
            windowBounds.y < candidate.bounds.y + candidate.bounds.height,
        );
        if (!display?.bounds || !windowBounds)
          throw new Error("Missing test window or display bounds");
        await helper.request({
          op: "start",
          sessionId: "native-app",
          target: { kind: "app", bundleId: "dev.ace.screen-test", displayId: display.displayId },
          fps: 10,
          allowlist: ["dev.ace.screen-test"],
        });
        const appFrame = await appReceived.promise;
        if (permissions.accessibility) {
          await expect(
            helper.request({
              op: "action",
              action: { kind: "click", x: appFrame.header.width + 1, y: 1, button: "left" },
            }),
          ).rejects.toThrow("outside capture bounds");
          await helper.request({ op: "action", action: { kind: "type", text: "" } });
          const text = "abcdefghijklmnop🙂 qrstuvwxyz ace input across multiple events";
          const typed = once(app.stdout, "line");
          await helper.request({ op: "action", action: { kind: "type", text } });
          expect((await typed)[0]).toBe(`typed:${text}`);
          const clicked = once(app.stdout, "line");
          await helper.request({
            op: "action",
            action: {
              kind: "click",
              x:
                ((windowBounds.x + 120 - display.bounds.x) * appFrame.header.width) /
                display.bounds.width,
              y:
                ((windowBounds.y + windowBounds.height - 46 - display.bounds.y) *
                  appFrame.header.height) /
                display.bounds.height,
              button: "left",
            },
          });
          expect((await clicked)[0]).toBe("clicked");
          const keyed = once(app.stdout, "line");
          await helper.request({
            op: "action",
            action: { kind: "key", keyCode: 36, modifiers: [] },
          });
          expect((await keyed)[0]).toBe("clicked");
          const scrolled = once(app.stdout, "line");
          await helper.request({
            op: "action",
            action: {
              kind: "scroll",
              x:
                ((windowBounds.x + 280 - display.bounds.x) * appFrame.header.width) /
                display.bounds.width,
              y:
                ((windowBounds.y + windowBounds.height - 60 - display.bounds.y) *
                  appFrame.header.height) /
                display.bounds.height,
              deltaX: 0,
              deltaY: 100,
            },
          });
          expect((await scrolled)[0]).toBe("scrolled");
        } else {
          await expect(
            helper.request({ op: "action", action: { kind: "type", text: "ace input" } }),
          ).rejects.toThrow("permission denied");
        }
        await helper.request({ op: "stop" });
      } finally {
        await app.stop({ graceMs: 0 });
      }
    } finally {
      await helper.close();
    }
  },
  180_000,
);

// Real Windows: the CI-built helper against owned fixture windows (scripts/vitest-windows-screen.config.ts).
const EditStartup = z.object({
  hwnd: z.number().int().positive(),
  visible: z.boolean(),
  dwmStatus: z.number().int(),
  session: z.number().int().nonnegative(),
});
const Allowlist = z.array(z.string().min(1).max(256));

function isJpeg(payload: Buffer): boolean {
  if (payload.length < 4) return false;
  const head = payload.readUInt16BE(0) === 0xffd8;
  const tail = payload.readUInt16BE(payload.length - 2) === 0xffd9;
  return head && tail;
}

function findRefInTree(node: unknown, wanted: string): string | undefined {
  const parsed = z
    .object({
      ref: z.string(),
      name: z.string(),
      value: z.string().optional(),
      children: z.array(z.unknown()),
    })
    .safeParse(node);
  if (parsed.success === false) return undefined;
  if (parsed.data.name === wanted || parsed.data.value === wanted) return parsed.data.ref;
  for (const child of parsed.data.children) {
    const found = findRefInTree(child, wanted);
    if (found !== undefined) return found;
  }
  return undefined;
}

it.runIf(process.platform === "win32")(
  "native Windows helper answers inventory then typed refusals without side effects",
  async () => {
    const failures: Error[] = [];
    const { helper } = await nativeWindowsHelper({ onFailure: (error) => failures.push(error) });
    try {
      expect(helper.capabilities?.platform).toBe("windows");
      expect(helper.capabilities?.codecs).toContain("jpeg");
      expect(await helper.request({ op: "permissions" })).toEqual({
        screenRecording: true,
        accessibility: true,
      });
      const inventory = ScreenInventory.parse(await helper.request({ op: "targets" }));
      expect(inventory.windows.length).toBeLessThanOrEqual(2048);
      expect(inventory.displays.length).toBeLessThanOrEqual(64);
      await expect(
        helper.request({ op: "ui.tree", allowlist: [], maxDepth: 1, maxNodes: 1 }),
      ).rejects.toMatchObject({ code: "target_gone" });
      await expect(
        helper.request({
          op: "open.url",
          bundleId: "ace.test",
          allowlist: ["ace.test"],
          url: "https://example.test/",
        }),
      ).rejects.toMatchObject({ code: "not_supported", phase: "rejected-before-dispatch" });
      expect(await helper.request({ op: "permissions" })).toEqual({
        screenRecording: true,
        accessibility: true,
      });
      const again = ScreenInventory.parse(await helper.request({ op: "targets" }));
      expect(again.windows.length).toBeLessThanOrEqual(2048);
      expect(again.displays.length).toBeLessThanOrEqual(64);
      expect(failures).toEqual([]);
    } finally {
      await helper.close();
    }
  },
);

it.runIf(process.platform === "win32")(
  "owned Windows form captures JPEG, edits Unicode through UIA and repaints pixels",
  async () => {
    const { started } = await ownedWindow(
      "owned-edit-fixture.ps1",
      { ACE_OWNED_TITLE: `ace-owned-${randomUUID()}` },
      EditStartup,
    );
    const hwnd = started.hwnd;
    const fixtureFacts = JSON.stringify(started);
    const frames: Frame[] = [];
    const failures: Error[] = [];
    const listeners: Array<() => void> = [];
    const notify = () => {
      const pending = listeners.splice(0, listeners.length);
      for (const listener of pending) listener();
    };
    const native = await nativeWindowsHelper({
      onFrame: (frame: Frame) => {
        frames.push(frame);
        notify();
      },
      onFailure: (error: Error) => {
        failures.push(error);
        notify();
      },
    });
    const helper = native.helper;
    try {
      const waitFrame = (from: number, timeoutMs: number, different: Buffer | undefined) =>
        new Promise<Frame>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Frame deadline elapsed")), timeoutMs);
          const poll = () => {
            if (failures.length > 0) {
              clearTimeout(timer);
              const failure = failures[0];
              void Promise.resolve(native.exited()).then((exit) => {
                reject(
                  new Error(
                    `Helper failed during frame wait: ${failure?.message}; exit=${JSON.stringify(exit)}; stderr=${native.stderr()}`,
                    { cause: failure },
                  ),
                );
              });
              return;
            }
            for (let index = from; index < frames.length; index += 1) {
              const frame = frames[index];
              if (frame === undefined) continue;
              if (different !== undefined && Buffer.compare(frame.payload, different) === 0)
                continue;
              clearTimeout(timer);
              resolve(frame);
              return;
            }
            listeners.push(poll);
          };
          poll();
        });
      const inventory = ScreenInventory.parse(await helper.request({ op: "targets" }));
      const owned = inventory.windows.find((entry) => entry.windowId === hwnd);
      if (owned === undefined)
        throw new Error(
          `Owned window missing from ${inventory.windows.length} visible targets: ${fixtureFacts}`,
        );
      const target = ScreenTarget.parse({
        kind: "window",
        bundleId: owned.bundleId,
        windowId: hwnd,
      });
      const allowlist = Allowlist.parse([owned.bundleId]);
      await helper.request({ op: "start", sessionId: "ownedcap1", target, allowlist, fps: 10 });
      const first = await waitFrame(0, 30_000, undefined);
      expect(first.header.width).toBeGreaterThan(0);
      expect(first.header.height).toBeGreaterThan(0);
      expect(isJpeg(first.payload)).toBe(true);
      const tree = ScreenUITree.parse(
        await helper.request({ op: "ui.tree", target, allowlist, maxDepth: 8, maxNodes: 128 }),
      );
      const fromTree = tree.root === null ? undefined : findRefInTree(tree.root, "OwnedEdit");
      const found = ScreenUIFindResult.parse(
        await helper.request({
          op: "ui.find",
          target,
          allowlist,
          query: { name: "OwnedEdit" },
          limit: 8,
        }),
      );
      const ref = found.nodes[0]?.ref ?? fromTree;
      if (ref === undefined) throw new Error("Owned textbox was not found");
      expect(found.nodes[0]?.actions).toContain("setValue");
      const repaintFrom = frames.length;
      const value = "Hello \u4f60\u597d \ud83d\ude00";
      const acted = ScreenUIActResult.parse(
        await helper.request({ op: "ui.act", target, allowlist, ref, action: "setValue", value }),
      );
      expect(acted.fallback).toBe(false);
      const reread = ScreenUIFindResult.parse(
        await helper.request({
          op: "ui.find",
          target,
          allowlist,
          query: { text: value },
          limit: 8,
        }),
      );
      expect(reread.nodes.some((node) => node.value === value)).toBe(true);
      const repainted = await waitFrame(repaintFrom, 30_000, first.payload);
      expect(repainted.header.width).toBeGreaterThan(0);
      expect(repainted.header.height).toBeGreaterThan(0);
      expect(isJpeg(repainted.payload)).toBe(true);
      expect(Buffer.compare(repainted.payload, first.payload) === 0).toBe(false);
      await helper.request({ op: "stop" });
      expect(await helper.request({ op: "permissions" })).toBeDefined();
      expect(failures).toEqual([]);
    } finally {
      await helper.close();
    }
  },
  120_000,
);
