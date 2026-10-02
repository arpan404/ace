import { once } from "node:events";
import { join } from "node:path";
import { expect, it } from "vitest";
import { probeOutput, spawnSupervised } from "@ace/provider-kit/process";
import { ScreenInventory, ScreenPermissions } from "@ace/protocol";
import { Helper, type Frame } from "./index.ts";
import { deferred, ids } from "./testing/support.ts";
const directory = new URL("../../../native/screen-helper/", import.meta.url).pathname;
it.skipIf(process.platform !== "darwin" || process.env.ACE_SCREEN_INTEGRATION !== "1")(
  "macOS captures JPEG frames from a dedicated approved test window",
  async (context) => {
    expect((await probeOutput("sh", [join(directory, "build.sh")])).code).toBe(0);
    const received = deferred<Frame>();
    const helper = await Helper.open({
      command: join(directory, "build/ace-screen-helper"),
      nextId: ids(),
      onFrame: received.resolve,
      onFailure: () => {},
    });
    try {
      const permissions = ScreenPermissions.parse(await helper.request({ op: "permissions" }));
      if (!permissions.screenRecording) {
        context.skip("Screen Recording permission has not been granted");
        return;
      }
      expect((await probeOutput("sh", [join(directory, "build-test-window.sh")])).code).toBe(0);
      const app = spawnSupervised({
        command: join(directory, "build/ScreenTest.app/Contents/MacOS/ScreenTest"),
        name: "screen-test-window",
        env: {},
      });
      try {
        await once(app.stdout, "line");
        const content = ScreenInventory.parse(await helper.request({ op: "targets" }));
        const window = content.windows.find(
          (candidate) =>
            candidate.bundleId === "dev.ace.screen-test" &&
            candidate.title === "ace screen integration",
        );
        if (!window) throw new Error("Test window is not visible to ScreenCaptureKit");
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
        if (permissions.accessibility) {
          await expect(
            helper.request({
              op: "action",
              action: { kind: "click", x: frame.header.width + 1, y: 1, button: "left" },
            }),
          ).rejects.toThrow("outside capture bounds");
          const text = "abcdefghijklmnop🙂 qrstuvwxyz ace input across multiple events";
          const typed = once(app.stdout, "line");
          await helper.request({ op: "action", action: { kind: "type", text } });
          expect((await typed)[0]).toBe(`typed:${text}`);
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
  30_000,
);
