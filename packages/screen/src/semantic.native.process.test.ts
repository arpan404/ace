import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { probeOutput, spawnSupervised } from "@ace/provider-kit/process";
import {
  ScreenCapabilities,
  ScreenInventory,
  ScreenUIFindResult,
  ScreenUITreeResult,
  ScreenUIActResult,
} from "@ace/protocol";
import { Helper } from "./index.ts";
import { fakeCommand, ids } from "./testing/support.ts";

it.skipIf(process.platform !== "darwin" || process.env.ACE_SCREEN_INTEGRATION !== "1")(
  "native AX refs and bounded text survive capture stop and resized windows receive semantic and point input",
  async (context) => {
    const directory = new URL("../../../native/screen-helper/", import.meta.url).pathname;
    expect(
      (await probeOutput("sh", [join(directory, "build.sh")], { timeoutMs: 120_000 })).code,
    ).toBe(0);
    expect(
      (await probeOutput("sh", [join(directory, "build-test-window.sh")], { timeoutMs: 120_000 }))
        .code,
    ).toBe(0);
    const helper = await Helper.open({
      command: join(directory, "build/ace-screen-helper"),
      // Opt-in runs use the grants of the terminal that runs them, as before the helper
      // disclaimed its launcher.
      args: ["--inherit-responsibility"],
      nextId: ids(),
      onFrame: () => {},
      onFailure: () => {},
    });
    onTestFinished(() => helper.close());
    const capabilities = ScreenCapabilities.parse(await helper.negotiate());
    if (
      capabilities.permissions.input !== "granted" ||
      capabilities.permissions.screen !== "granted"
    ) {
      context.skip("Accessibility and Screen Recording must be granted by the user");
      return;
    }
    const app = spawnSupervised({
      command: join(directory, "build/ScreenTest.app/Contents/MacOS/ScreenTest"),
      args: ["ace semantic test", "--large-text", "-ApplePersistenceIgnoreState", "YES"],
      env: {},
      name: "semantic-fixture",
    });
    onTestFinished(async () => {
      await app.stop({ graceMs: 0 });
    });
    await once(app.stdout, "line");
    const scope = {
      target: { kind: "app", bundleId: "dev.ace.screen-test", displayId: 1 } as const,
      allowlist: ["dev.ace.screen-test"],
    };
    const limited = ScreenUITreeResult.parse(
      await helper.request({ op: "ui.tree", ...scope, maxDepth: 0, maxNodes: 1 }),
    );
    expect(limited.nodes).toHaveLength(1);
    expect(limited.nodes[0]?.children).toEqual([]);
    expect(limited.truncated).toBe(true);
    const find = () =>
      helper.request({
        op: "ui.find",
        ...scope,
        query: { name: "Click test", role: "AXButton" },
        limit: 1,
      });
    const first = ScreenUIFindResult.parse(await find()),
      second = ScreenUIFindResult.parse(await find());
    const ref = first.nodes[0]?.ref;
    if (!ref) throw new Error("Fixture button was not found");
    expect(second.nodes[0]?.ref).toBe(ref);
    const clicked = once(app.stdout, "line");
    expect(
      ScreenUIActResult.parse(
        await helper.request({ op: "ui.act", ...scope, ref, action: "press" }),
      ).fallback,
    ).toBe(false);
    expect((await clicked)[0]).toBe("clicked");
    await helper.request({ op: "stop" });
    expect(ScreenUIFindResult.parse(await find()).nodes[0]?.ref).toBe(ref);
    const secure = ScreenUIFindResult.parse(
      await helper.request({ op: "ui.find", ...scope, query: { name: "Secret test" }, limit: 1 }),
    ).nodes[0];
    if (!secure) throw new Error("Fixture secure field was not found");
    expect(secure.value).toBeUndefined();
    expect(secure.actions).not.toContain("setValue");
    await expect(
      helper.request({
        op: "ui.act",
        ...scope,
        ref: secure.ref,
        action: "setValue",
        value: "secret",
      }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      helper.request({ op: "ui.act", ...scope, allowlist: [], ref, action: "press" }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    const document = ScreenUIFindResult.parse(
      await helper.request({
        op: "ui.find",
        ...scope,
        query: { name: "Large text test" },
        limit: 1,
      }),
    );
    expect(document.nodes).toHaveLength(1);
    expect(document.nodes[0]?.value).toBe("Q".repeat(256));
    expect(document.truncated).toBe(true);
    const inventory = ScreenInventory.parse(await helper.request({ op: "targets" }));
    const window = inventory.windows.find((entry) => entry.bundleId === "dev.ace.screen-test");
    if (!window) throw new Error("Fixture window was not found");
    const windowScope = {
      target: {
        kind: "window",
        bundleId: "dev.ace.screen-test",
        windowId: window.windowId,
      } as const,
      allowlist: scope.allowlist,
    };
    await helper.request({
      op: "start",
      ...windowScope,
      sessionId: "resize",
      fps: 10,
      capture: false,
    });
    const resize = ScreenUIFindResult.parse(
      await helper.request({
        op: "ui.find",
        ...windowScope,
        query: { name: "Resize test" },
        limit: 1,
      }),
    ).nodes[0];
    if (!resize) throw new Error("Fixture resize button was not found");
    const resized = once(app.stdout, "line");
    await helper.request({ op: "ui.act", ...windowScope, ref: resize.ref, action: "press" });
    expect((await resized)[0]).toBe("resized");
    const root = ScreenUITreeResult.parse(
      await helper.request({ op: "ui.tree", ...windowScope, maxDepth: 0, maxNodes: 1 }),
    ).nodes[0];
    const button = ScreenUIFindResult.parse(
      await helper.request({
        op: "ui.find",
        ...windowScope,
        query: { name: "Click test", role: "AXButton" },
        limit: 1,
      }),
    ).nodes[0];
    if (!root || !button) throw new Error("Resized fixture geometry was not found");
    const x = button.bounds.x + button.bounds.w / 2 - root.bounds.x;
    const y = button.bounds.y + button.bounds.h / 2 - root.bounds.y;
    if (!window.bounds) throw new Error("Initial fixture geometry was not found");
    expect(y).toBeGreaterThan(window.bounds.height);
    const resizedClick = once(app.stdout, "line");
    await helper.request({ op: "input", input: { kind: "pointer.click", x, y, button: "left" } });
    expect((await resizedClick)[0]).toBe("clicked");
    const resizedKey = once(app.stdout, "line");
    await helper.request({
      op: "input",
      input: { kind: "key.press", key: "enter", modifiers: [] },
    });
    expect((await resizedKey)[0]).toBe("clicked");
    await app.stop({ graceMs: 0 });
    await expect(
      helper.request({ op: "ui.act", ...scope, ref, action: "press" }),
    ).rejects.toMatchObject({ code: "target_gone" });
  },
  180_000,
);
it("a v2 helper permission denial remains typed and does not become a plausible tree", async () => {
  const helper = await Helper.open({
    ...fakeCommand,
    env: { FAKE_V2: "1", ACCESS_DENIED: "1" },
    nextId: ids(),
    onFrame: () => {},
    onFailure: () => {},
  });
  onTestFinished(() => helper.close());
  await helper.negotiate();
  await expect(
    helper.request({
      op: "ui.tree",
      target: { kind: "window", bundleId: "dev.ace.test", windowId: 1 },
      allowlist: ["dev.ace.test"],
      maxNodes: 10,
      maxDepth: 3,
    }),
  ).rejects.toMatchObject({ code: "permission_denied" });
});

it.skipIf(process.platform !== "darwin" || process.env.ACE_SCREEN_INTEGRATION !== "1")(
  "an unchanged native build retains its installed executable identity and signature bytes",
  async () => {
    const directory = new URL("../../../native/screen-helper/", import.meta.url).pathname;
    const build = () => probeOutput("sh", [join(directory, "build.sh")], { timeoutMs: 120_000 });
    expect((await build()).code).toBe(0);
    const binary = join(directory, "build/AceScreenHelper.app/Contents/MacOS/ace-screen-helper");
    const before = await stat(binary);
    const digest = createHash("sha256")
      .update(await readFile(binary))
      .digest("hex");
    expect((await build()).code).toBe(0);
    const after = await stat(binary);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(
      createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
    ).toBe(digest);
  },
  180_000,
);
