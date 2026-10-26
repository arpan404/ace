import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { probeOutput, spawnSupervised } from "@ace/provider-kit/process";
import {
  ScreenCapabilities,
  ScreenInventory,
  ScreenTarget,
  ScreenUIFindResult,
  ScreenUITreeResult,
  ScreenUIActResult,
} from "@ace/protocol";
import { Helper } from "./index.ts";
import { nativeWindowsHelper, ownedWindow } from "./testing/owned-window.ts";
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
    // Exercise Accessibility.act through the native command channel, including
    // unreadable state and a provider that refuses the actual AX write.
    for (const name of ["Collapse test", "Unreadable expansion test", "Refused expansion test"]) {
      const node = ScreenUIFindResult.parse(
        await helper.request({ op: "ui.find", ...scope, query: { name }, limit: 1 }),
      ).nodes[0];
      if (!node) throw new Error(`Missing expansion fixture: ${name}`);
      const collapse = {
        op: "ui.act",
        ...scope,
        ref: node.ref,
        action: "expand",
        value: false,
      } as const;
      if (name === "Refused expansion test") {
        await expect(helper.request(collapse)).rejects.toMatchObject({ code: "not_supported" });
      } else {
        const written = once(app.stdout, "line");
        expect(ScreenUIActResult.parse(await helper.request(collapse)).fallback).toBe(false);
        expect((await written)[0]).toBe(`expanded:${name}:false`);
        if (name === "Collapse test") {
          const collapsed = ScreenUIFindResult.parse(
            await helper.request({ op: "ui.find", ...scope, query: { name }, limit: 1 }),
          ).nodes[0];
          expect(collapsed?.states).not.toContain("expanded");
          expect(ScreenUIActResult.parse(await helper.request(collapse)).fallback).toBe(false);
        }
      }
    }
    // An ordinary button has no expanded state or writable AXExpanded attribute.
    await expect(
      helper.request({ op: "ui.act", ...scope, ref, action: "expand", value: false }),
    ).rejects.toMatchObject({ code: "not_supported" });
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

// Real Windows: the CI-built helper drives an owned fixture form (scripts/vitest-windows-screen.config.ts).
const InputStartup = z.object({
  main: z.number().int().positive(),
  decoy: z.number().int().positive(),
  visible: z.boolean(),
  session: z.number().int().nonnegative(),
});
const ForegroundLine = z.object({
  foreground: z.number().int().positive(),
  foregroundPid: z.number().int().nonnegative(),
  foregroundName: z.string().max(256),
  foregroundSession: z.number().int().min(-1),
  foregroundClass: z.string().max(256),
  main: z.number().int().positive(),
  decoy: z.number().int().positive(),
  pid: z.number().int().positive(),
  which: z.enum(["main", "decoy", "snapshot"]),
  mainText: z.string().max(512),
  decoyText: z.string().max(512),
  count: z.string().max(16),
  selectAllCount: z.number().int().nonnegative(),
});
const Allowlist = z.array(z.string().min(1).max(256));

function center(bounds: { x: number; y: number; w: number; h: number }): {
  x: number;
  y: number;
} {
  return { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
}

it.runIf(process.platform === "win32")(
  "owned Windows form accepts pointer, Unicode text and keys only in its own foreground",
  async () => {
    const title = `ace-owned-input-${randomUUID()}`;
    const owned = await ownedWindow(
      "owned-input-fixture.ps1",
      { ACE_OWNED_TITLE: title, ACE_OWNED_DECOY: `${title}-decoy` },
      InputStartup,
    );
    const { started, stdin, lines } = owned;
    const foreground = (which: "main" | "decoy" | "snapshot", wanted: number) =>
      new Promise<z.infer<typeof ForegroundLine>>((resolve, reject) => {
        let last: z.infer<typeof ForegroundLine> | undefined;
        const timer = setTimeout(() => {
          lines.removeListener("line", onLine);
          reject(
            new Error(
              `Foreground ${which} timed out, wanted=${wanted}, fixtureSession=${started.session}: ${JSON.stringify(last)}; ${owned.stderr()}`,
            ),
          );
        }, 30_000);
        const send = () => {
          stdin.write(`${which}\n`, (error: Error | undefined | null) => {
            if (error) {
              clearTimeout(timer);
              lines.removeListener("line", onLine);
              reject(error);
            }
          });
        };
        const onLine = (line: string) => {
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            return;
          }
          const parsed = ForegroundLine.safeParse(raw);
          if (!parsed.success || parsed.data.which !== which) return;
          last = parsed.data;
          if (parsed.data.foreground !== wanted) {
            // Normal activation may complete after its request returns. The fixture's
            // UI timer yields between replies; keep the same deadline and exact HWND.
            send();
            return;
          }
          clearTimeout(timer);
          lines.removeListener("line", onLine);
          resolve(parsed.data);
        };
        lines.on("line", onLine);
        send();
      });
    const snapshot = async () => {
      const { promise, resolve, reject } = Promise.withResolvers<z.infer<typeof ForegroundLine>>();
      const onLine = (line: string) => {
        try {
          const parsed = ForegroundLine.safeParse(JSON.parse(line));
          if (parsed.success && parsed.data.which === "snapshot") resolve(parsed.data);
        } catch {
          // Startup and diagnostic lines share stdout; only accept schema-valid state.
        }
      };
      const timer = setTimeout(() => reject(new Error("Diagnostic snapshot timed out")), 1_000);
      lines.on("line", onLine);
      stdin.write("snapshot\n");
      try {
        return await promise;
      } finally {
        clearTimeout(timer);
        lines.removeListener("line", onLine);
      }
    };
    const failures: Error[] = [];
    const native = await nativeWindowsHelper({ onFailure: (error) => failures.push(error) });
    const helper = native.helper;
    try {
      const inventory = ScreenInventory.parse(await helper.request({ op: "targets" }));
      const ownedMain = inventory.windows.find((entry) => entry.windowId === started.main);
      if (ownedMain === undefined)
        throw new Error(`Owned main missing: ${JSON.stringify(started)}`);
      const decoy = inventory.windows.find((entry) => entry.windowId === started.decoy);
      if (decoy === undefined) throw new Error(`Owned decoy missing: ${JSON.stringify(started)}`);
      const target = ScreenTarget.parse({
        kind: "window",
        bundleId: ownedMain.bundleId,
        windowId: started.main,
      });
      const allowlist = Allowlist.parse([ownedMain.bundleId]);
      await helper.request({ op: "start", sessionId: "ownedinput1", target, allowlist, fps: 10 });
      await foreground("main", started.main);
      const live = helper;
      const findByName = async (name: string) => {
        const found = ScreenUIFindResult.parse(
          await live.request({ op: "ui.find", target, allowlist, query: { name }, limit: 8 }),
        );
        const node = found.nodes[0];
        if (node === undefined) throw new Error(`UI node ${name} missing`);
        return node;
      };
      const edit = await findByName("OwnedEdit");
      const editAt = center(edit.bounds);
      await helper.request({
        op: "input",
        input: { kind: "pointer.click", x: editAt.x, y: editAt.y, button: "left" },
      });
      await helper.request({
        op: "input",
        input: { kind: "key.press", key: "A", modifiers: ["control"] },
      });
      await helper.request({
        op: "input",
        input: { kind: "key.press", key: "Backspace", modifiers: [] },
      });
      await expect.poll(async () => (await findByName("OwnedEdit")).value).toBe("");
      expect(await foreground("snapshot", started.main)).toMatchObject({ selectAllCount: 1 });
      const sentinel = "Hello \u4f60\u597d \ud83d\ude00";
      await helper.request({ op: "input", input: { kind: "text.type", text: sentinel } });
      let observedValue: string | undefined;
      let readPending = false;
      try {
        await expect
          .poll(async () => {
            readPending = true;
            try {
              observedValue = (await findByName("OwnedEdit")).value;
              return observedValue;
            } finally {
              readPending = false;
            }
          })
          .toBe(sentinel);
      } catch (error) {
        const state = await snapshot().catch((failure: Error) => failure.message);
        throw new Error(
          `[DEBUG-win-unicode] ${JSON.stringify({ observedValue, readPending, state, nativeStderr: native.stderr() })}`,
          { cause: error },
        );
      }
      expect((await findByName("OwnedCount")).value).toBe("0");
      const button = await findByName("OwnedButton");
      const buttonAt = center(button.bounds);
      await helper.request({
        op: "input",
        input: { kind: "pointer.click", x: buttonAt.x, y: buttonAt.y, button: "left" },
      });
      await expect.poll(async () => (await findByName("OwnedCount")).value).toBe("1");
      await foreground("decoy", started.decoy);
      await expect(
        helper.request({
          op: "input",
          input: { kind: "pointer.click", x: buttonAt.x, y: buttonAt.y, button: "left" },
        }),
      ).rejects.toMatchObject({ code: "busy" });
      await expect(
        helper.request({ op: "input", input: { kind: "text.type", text: "must-not-arrive" } }),
      ).rejects.toMatchObject({ code: "busy" });
      const refused = await foreground("snapshot", started.decoy);
      expect(refused).toMatchObject({ mainText: sentinel, decoyText: "decoy", count: "1" });
      expect((await findByName("OwnedEdit")).value).toBe(sentinel);
      expect((await findByName("OwnedCount")).value).toBe("1");
      await foreground("main", started.main);
      const again = await findByName("OwnedButton");
      const againAt = center(again.bounds);
      await helper.request({
        op: "input",
        input: { kind: "pointer.click", x: againAt.x, y: againAt.y, button: "left" },
      });
      await expect.poll(async () => (await findByName("OwnedCount")).value).toBe("2");
      expect(failures, native.stderr()).toEqual([]);
      await helper.request({ op: "stop" });
    } finally {
      await helper.close();
    }
  },
);
