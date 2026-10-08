import { join } from "node:path";
import { z } from "zod";
import { expect, it, onTestFinished } from "vitest";
import { probeOutput, spawnSupervised } from "@ace/provider-kit/process";
import { ScreenInventory, ScreenUITreeResult } from "@ace/protocol";
import { Helper } from "./index.ts";
import { ids, deferred } from "./testing/support.ts";

const root = new URL("../../../native/screen-helper/", import.meta.url).pathname;
const bundleId = "dev.ace.identity-fixture";
const allowlist = [bundleId];
const fixtureLine = z.object({
  ready: z.array(z.number()).optional(),
  active: z.boolean().optional(),
  values: z.array(z.string()).optional(),
  eventWindow: z.number().optional(),
  keyCode: z.number().optional(),
  down: z.boolean().optional(),
  menu: z.string().optional(),
  urls: z.array(z.string()).optional(),
  moved: z.boolean().optional(),
});
const integration = process.platform === "darwin" && process.env.ACE_SCREEN_INTEGRATION === "1";

it.skipIf(!integration)(
  "identical and off-display fixture windows keep exact AX/input/capture identity without activating an app",
  async (context) => {
    expect((await probeOutput("sh", [join(root, "build.sh")], { timeoutMs: 120_000 })).code).toBe(
      0,
    );
    expect(
      (await probeOutput("sh", [join(root, "Tests/Fixture/build.sh")], { timeoutMs: 120_000 }))
        .code,
    ).toBe(0);
    const frame = deferred<void>();
    const helper = await Helper.open({
      command: process.env.IDENTITY_HELPER ?? join(root, "build/ace-screen-helper"),
      args: ["--inherit-responsibility"],
      nextId: ids(),
      onFrame: () => frame.resolve(),
      onFailure: () => {},
    });
    onTestFinished(() => helper.close());
    const capabilities = await helper.negotiate();
    if (
      capabilities?.permissions.screen !== "granted" ||
      capabilities.permissions.input !== "granted"
    ) {
      context.skip("Requires existing Screen Recording and Accessibility grants");
      return;
    }
    const app = spawnSupervised({
      command: join(root, "build/IdentityFixture.app/Contents/MacOS/IdentityFixture"),
      args: ["-ApplePersistenceIgnoreState", "YES"],
      env: {},
      name: "identity-fixture",
    });
    onTestFinished(async () => {
      await app.stop({ graceMs: 0 });
    });
    const events: z.infer<typeof fixtureLine>[] = [];
    const waiting = new Set<() => void>();
    app.stdout.on("line", (line: string) => {
      events.push(fixtureLine.parse(JSON.parse(line)));
      for (const notify of waiting) notify();
    });
    function event(predicate: (value: z.infer<typeof fixtureLine>) => boolean) {
      return new Promise<z.infer<typeof fixtureLine>>((resolve) => {
        const notify = () => {
          const index = events.findIndex(predicate);
          if (index < 0) return;
          const value = events.splice(index, 1)[0];
          if (value) {
            waiting.delete(notify);
            resolve(value);
          }
        };
        waiting.add(notify);
        notify();
      });
    }
    const ready = await event((value) => value.ready !== undefined);
    const firstId = ready.ready?.[0],
      secondId = ready.ready?.[1];
    if (!firstId || !secondId) throw new Error("Missing fixture window IDs");
    const initialInventory = ScreenInventory.parse(await helper.request({ op: "targets" }));
    const firstWindow = initialInventory.windows.find((window) => window.windowId === firstId);
    const secondWindow = initialInventory.windows.find((window) => window.windowId === secondId);
    expect(firstWindow?.bounds?.x).toBeGreaterThanOrEqual(100000);
    expect(secondWindow?.bounds).toEqual(firstWindow?.bounds);
    const scope = {
      sessionId: "identity",
      target: { kind: "window", bundleId, windowId: firstId } as const,
      allowlist,
    };
    await helper.request({ op: "start", ...scope, fps: 10, capture: false });
    const tree = ScreenUITreeResult.parse(
      await helper.request({ op: "ui.tree", ...scope, maxDepth: 5, maxNodes: 32 }),
    );
    expect(tree.nodes[0]?.name).toBe("Identity 0");
    const field = ScreenUITreeResult.parse(
      await helper.request({ op: "ui.find", ...scope, query: { name: "Destination 0" }, limit: 1 }),
    ).nodes[0];
    if (!field) throw new Error("Missing destination");
    await helper.request({
      op: "ui.act",
      ...scope,
      ref: field.ref,
      action: "setValue",
      value: "zero",
    });
    app.stdin.write("snapshot\n");
    expect((await event((value) => value.values !== undefined)).values).toEqual(["zero", ""]);
    await helper.request({
      op: "input",
      sessionId: scope.sessionId,
      input: { kind: "text.type", text: "abc" },
    });
    app.stdin.write("snapshot\n");
    const typedSnapshot = await event((value) => value.values !== undefined);
    expect(typedSnapshot.active).toBe(false);
    const typed = typedSnapshot.values;
    expect(typed?.[0]).toContain("abc");
    expect(typed?.[1]).toBe("");
    await helper.request({
      op: "input",
      sessionId: scope.sessionId,
      input: { kind: "text.paste", text: "paste" },
    });
    app.stdin.write("snapshot\n");
    expect((await event((value) => value.values !== undefined)).values?.[0]).toContain("paste");
    // AX arrow editing moves this destination without using the app's other key window.
    await expect(
      helper.request({
        op: "input",
        sessionId: scope.sessionId,
        input: { kind: "key.press", key: "ArrowRight", modifiers: [] },
      }),
    ).resolves.toBeDefined();
    // Function keys use the raw route only when its actual responder is the requested window.
    await expect(
      helper.request({
        op: "input",
        sessionId: scope.sessionId,
        input: { kind: "key.press", key: "F5", modifiers: [] },
      }),
    ).rejects.toMatchObject({ code: "no_key_window", phase: "rejected-before-dispatch" });
    await expect(
      helper.request({
        op: "input",
        sessionId: scope.sessionId,
        input: { kind: "key.press", key: "Cmd+L", modifiers: [] },
      }),
    ).rejects.toMatchObject({ code: "key_unsupported", phase: "rejected-before-dispatch" });
    // A menu target fires without changing the observed text tree.
    await expect(
      helper.request({
        op: "menu.press",
        sessionId: scope.sessionId,
        path: ["Fixture", "Signal"],
      }),
    ).resolves.toBeDefined();
    expect((await event((value) => value.menu !== undefined)).menu).toBe("signal");
    await helper.request({ op: "open.url", bundleId, allowlist, url: "ace-fixture://identity" });
    expect((await event((value) => value.urls !== undefined)).urls).toEqual([
      "ace-fixture://identity",
    ]);
    await helper.request({ op: "capture", sessionId: scope.sessionId, enabled: true });
    await frame.promise;
    await helper.request({ op: "stop", sessionId: scope.sessionId });
    // A second window at a different off-display frame retains its own destination too.
    app.stdin.write("offdisplay\n");
    await event((value) => value.moved === true);
    const movedInventory = ScreenInventory.parse(await helper.request({ op: "targets" }));
    expect(
      movedInventory.windows.find((window) => window.windowId === secondId)?.bounds?.x,
    ).toBeGreaterThanOrEqual(110000);
    const second = { ...scope, target: { ...scope.target, windowId: secondId } };
    await helper.request({ op: "start", ...second, fps: 10, capture: false });
    expect(
      ScreenUITreeResult.parse(
        await helper.request({ op: "ui.tree", ...second, maxNodes: 16, maxDepth: 4 }),
      ).nodes[0]?.name,
    ).toBe("Identity 1");
    await helper.request({
      op: "input",
      sessionId: scope.sessionId,
      input: { kind: "text.type", text: "second" },
    });
    app.stdin.write("snapshot\n");
    const values = (await event((value) => value.values !== undefined)).values;
    expect(values?.[0]).toContain("paste");
    expect(values?.[1]).toBe("second");
    await expect(
      helper.request({
        op: "input",
        sessionId: scope.sessionId,
        input: { kind: "key.press", key: "F5", modifiers: [] },
      }),
    ).rejects.toMatchObject({ code: "delivery_unconfirmed", phase: "dispatched" });
    expect(
      (await event((value) => value.eventWindow !== undefined && value.down === true)).eventWindow,
    ).toBe(secondId);
    await expect(
      helper.request({
        op: "input",
        sessionId: scope.sessionId,
        mode: "foreground",
        input: { kind: "pointer.click", x: 20, y: 20, button: "left" },
      }),
    ).rejects.toMatchObject({ code: "window_offscreen", phase: "rejected-before-dispatch" });
    await helper.request({ op: "stop", sessionId: scope.sessionId });
  },
  180_000,
);
