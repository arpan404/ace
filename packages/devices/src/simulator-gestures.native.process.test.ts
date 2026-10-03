import { once } from "node:events";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { probeOutput, spawnSupervised } from "@ace/provider-kit/process";
import { Helper } from "@ace/screen";
import {
  ScreenInventory,
  ScreenCapabilities,
  ScreenUITreeResult,
  ScreenUIFindResult,
} from "@ace/protocol";
it.skipIf(process.platform !== "darwin" || process.env["ACE_DEVICE_GESTURE_LIVE"] !== "1")(
  "native timed gestures activate and release the chosen window control in target points",
  async (context) => {
    const root = new URL("../../../native/screen-helper/", import.meta.url).pathname;
    for (const script of ["build.sh", "build-test-window.sh"]) {
      expect((await probeOutput("sh", [join(root, script)], { timeoutMs: 120000 })).code).toBe(0);
    }
    let id = 0;
    const helper = await Helper.open({
      command: join(root, "build/ace-screen-helper"),
      nextId: () => `gesture-${++id}`,
      onFrame: () => {},
      onFailure: () => {},
    });
    onTestFinished(() => helper.close());
    const capabilities = ScreenCapabilities.parse(await helper.negotiate());
    if (
      capabilities.permissions.screen !== "granted" ||
      capabilities.permissions.input !== "granted"
    ) {
      context.skip(
        "Grant Screen Recording and Accessibility to the native helper before this live test",
      );
      return;
    }
    const app = spawnSupervised({
      command: join(root, "build/ScreenTest.app/Contents/MacOS/ScreenTest"),
      args: ["ace timed gesture test", "-ApplePersistenceIgnoreState", "YES"],
      env: {},
      name: "gesture-native-fixture",
    });
    onTestFinished(async () => {
      await app.stop({ graceMs: 0 });
    });
    await once(app.stdout, "line");
    const window = ScreenInventory.parse(await helper.request({ op: "targets" })).windows.find(
      (candidate) =>
        candidate.bundleId === "dev.ace.screen-test" &&
        candidate.title === "ace timed gesture test",
    );
    if (!window) throw new Error("Native gesture fixture did not expose its window");
    const target = {
      kind: "window",
      windowId: window.windowId,
      bundleId: window.bundleId,
    } as const;
    const allowlist = [window.bundleId];
    await helper.request({
      op: "start",
      target,
      allowlist,
      sessionId: "native-gestures",
      fps: 1,
      capture: false,
    });
    const tree = ScreenUITreeResult.parse(
      await helper.request({ op: "ui.tree", target, allowlist, maxNodes: 1, maxDepth: 0 }),
    );
    const button = ScreenUIFindResult.parse(
      await helper.request({
        op: "ui.find",
        target,
        allowlist,
        query: { name: "Click test", role: "AXButton" },
        limit: 1,
      }),
    ).nodes[0];
    const windowNode = tree.nodes[0];
    if (!button || !windowNode) throw new Error("Native fixture control was unavailable");
    const x = button.bounds.x + button.bounds.w / 2 - windowNode.bounds.x;
    const y = button.bounds.y + button.bounds.h / 2 - windowNode.bounds.y;
    for (const toX of [x, x + 8]) {
      const activated = once(app.stdout, "line");
      await helper.request({
        op: "input",
        input: { kind: "pointer.drag", x, y, toX, toY: y, button: "left", durationMs: 400 },
      });
      expect((await activated)[0]).toBe("clicked");
    }
    await helper.request({ op: "stop" });
  },
);
