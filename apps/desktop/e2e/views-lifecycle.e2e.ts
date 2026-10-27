import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appEnvironment, desktop, electronBinary } from "../scripts/common.ts";

/**
 * The embedded browser's view lifecycle in real Electron: the app's own backend and view host,
 * wired to app windows as the app wires them. Opt in with ACE_E2E_ELECTRON=1
 * (`bun run desktop:e2e`).
 */
const enabled = process.env.ACE_E2E_ELECTRON === "1";
let app: ElectronApplication;
let out: string;
let userData: string;

interface Where {
  destroyed: boolean;
  inAppWindow: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  visible: boolean;
  appWindows: number;
  inner?: { width: number; height: number };
}
interface Harness {
  start(): Promise<void>;
  place(bounds: { x: number; y: number; width: number; height: number }): Promise<string>;
  loadedAt(): Promise<unknown>;
  closeWindow(): Promise<void>;
  openWindow(): Promise<void>;
  where(): Promise<Where>;
  resizeWindow(width: number, height: number): void;
  backgroundTab(): Promise<string>;
  rendering(tabId: string): Promise<{ frames: number; state: string }>;
  split(left: Box, right: Box): Promise<{ receipts: string[]; boxes: Box[] }>;
  pictureInPicture(
    panel: Box,
    floating: Box,
  ): Promise<{
    whileFloating: { receipt: string; bounds: Box; visible: boolean };
    back: string;
    visibility: boolean[];
    navigations: number;
    bounds: Box;
  }>;
  blip(): Promise<unknown>;
  typeAfterAddressShortcut(): Promise<unknown>;
  crashRepeatedly(times: number): Promise<{ events: string[]; crashed: boolean }>;
  reload(): Promise<{ events: string[]; crashed: boolean }>;
}

type Box = { x: number; y: number; width: number; height: number };

describe.skipIf(!enabled)("embedded view lifecycle", () => {
  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), "ace-e2e-lifecycle-build-"));
    await build({
      entryPoints: [join(desktop, "e2e/fixtures/views-lifecycle-main.ts")],
      outfile: join(out, "main.mjs"),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node26",
      external: ["electron"],
      logLevel: "warning",
      banner: {
        js: 'import { createRequire as __aceCreateRequire } from "node:module"; const require = __aceCreateRequire(import.meta.url);',
      },
    });
    userData = await mkdtemp(join(tmpdir(), "ace-e2e-lifecycle-"));
    app = await electron.launch({
      executablePath: await electronBinary(),
      args: [join(out, "main.mjs")],
      env: { ...appEnvironment(process.env), ACE_E2E_USER_DATA: userData },
    });
    await app.evaluate(async () => (Reflect.get(globalThis, "harness") as Harness).start());
  });

  afterAll(async () => {
    // Quit tears everything down, parked views included, and the app exits.
    await app?.close();
    if (userData) await rm(userData, { recursive: true, force: true });
    if (out) await rm(out, { recursive: true, force: true });
  });

  it("closing the last window keeps the thread's page alive and reopening shows it without a reload", async () => {
    const box = { x: 300, y: 120, width: 600, height: 400 };
    expect(
      await app.evaluate(
        (_e, b: Box) => (Reflect.get(globalThis, "harness") as Harness).place(b),
        box,
      ),
    ).toBe("shown");
    const loaded = await app.evaluate(() =>
      (Reflect.get(globalThis, "harness") as Harness).loadedAt(),
    );
    expect(loaded).toEqual(expect.any(Number));

    await app.evaluate(() => (Reflect.get(globalThis, "harness") as Harness).closeWindow());
    const parked = await app.evaluate(() =>
      (Reflect.get(globalThis, "harness") as Harness).where(),
    );
    expect(parked).toMatchObject({ destroyed: false, inAppWindow: false, appWindows: 0 });
    // The page still runs with no window: the daemon can drive it meanwhile.
    expect(
      await app.evaluate(() => (Reflect.get(globalThis, "harness") as Harness).loadedAt()),
    ).toBe(loaded);

    await app.evaluate(() => (Reflect.get(globalThis, "harness") as Harness).openWindow());
    expect(
      await app.evaluate(
        (_e, b: Box) => (Reflect.get(globalThis, "harness") as Harness).place(b),
        box,
      ),
    ).toBe("shown");
    expect(
      await app.evaluate(() => (Reflect.get(globalThis, "harness") as Harness).where()),
    ).toMatchObject({
      destroyed: false,
      inAppWindow: true,
      visible: true,
      bounds: box,
    });
    expect(
      await app.evaluate(() => (Reflect.get(globalThis, "harness") as Harness).loadedAt()),
    ).toBe(loaded);
  });

  it("placement after resize matches the frame", async () => {
    const before = { x: 300, y: 120, width: 600, height: 400 };
    expect(
      await app.evaluate(
        (_e, b: Box) => (Reflect.get(globalThis, "harness") as Harness).place(b),
        before,
      ),
    ).toBe("shown");
    await app.evaluate(() =>
      (Reflect.get(globalThis, "harness") as Harness).resizeWindow(1300, 900),
    );
    const after = { x: 420, y: 120, width: 820, height: 700 };
    expect(
      await app.evaluate(
        (_e, b: Box) => (Reflect.get(globalThis, "harness") as Harness).place(b),
        after,
      ),
    ).toBe("shown");
    // Once the window settles the view is re-applied; it stays exactly on its frame.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(
      await app.evaluate(() => (Reflect.get(globalThis, "harness") as Harness).where()),
    ).toMatchObject({
      bounds: after,
      inner: { width: after.width, height: after.height },
    });
  });

  it("moving the page into picture-in-picture and back never reloads it or hides it", async () => {
    const loaded = await app.evaluate(() =>
      (Reflect.get(globalThis, "harness") as Harness).loadedAt(),
    );
    const panel = { x: 300, y: 120, width: 600, height: 400 };
    const floating = { x: 640, y: 420, width: 300, height: 200 };
    const moved = await app.evaluate(
      (_e, boxes: { panel: Box; floating: Box }) =>
        (Reflect.get(globalThis, "harness") as Harness).pictureInPicture(
          boxes.panel,
          boxes.floating,
        ),
      { panel, floating },
    );
    expect(moved.whileFloating).toEqual({ receipt: "shown", bounds: floating, visible: true });
    expect(moved.back).toBe("shown");
    expect(moved.bounds).toEqual(panel);
    // Never hidden on the way (no flash) and never navigated (no reload).
    expect(moved.visibility).toEqual([]);
    expect(moved.navigations).toBe(0);
    expect(
      await app.evaluate(() => (Reflect.get(globalThis, "harness") as Harness).loadedAt()),
    ).toBe(loaded);
  });

  it("a second tab renders while not selected", async () => {
    const tabId = await app.evaluate(() =>
      (Reflect.get(globalThis, "harness") as Harness).backgroundTab(),
    );
    const rendering = await app.evaluate(
      (_e, id: string) => (Reflect.get(globalThis, "harness") as Harness).rendering(id),
      tabId,
    );
    expect(rendering.state).toBe("visible");
    expect(rendering.frames).toBeGreaterThan(10);
    // The panel still shows the thread's selected page.
    expect(
      await app.evaluate(() => (Reflect.get(globalThis, "harness") as Harness).where()),
    ).toMatchObject({ inAppWindow: true, visible: true });
  });

  it("split view draws two native tabs side by side", async () => {
    const left = { x: 300, y: 120, width: 400, height: 400 };
    const right = { x: 700, y: 120, width: 400, height: 400 };
    const result = await app.evaluate(
      (_e, boxes: { left: Box; right: Box }) =>
        (Reflect.get(globalThis, "harness") as Harness).split(boxes.left, boxes.right),
      { left, right },
    );
    expect(result.receipts).toEqual(["shown", "shown"]);
    expect(result.boxes).toEqual([left, right]);
  });

  it("keys typed right after ⌘L in the page land in the address field, first character included", async () => {
    expect(
      await app.evaluate(() =>
        (Reflect.get(globalThis, "harness") as Harness).typeAfterAddressShortcut(),
      ),
    ).toBe("go");
  });

  it("a backend reconnect re-adopts the page in place, with a working fresh debugger", async () => {
    const loaded = await app.evaluate(() =>
      (Reflect.get(globalThis, "harness") as Harness).loadedAt(),
    );
    const opened = await app.evaluate(() => (Reflect.get(globalThis, "harness") as Harness).blip());
    expect(opened).toMatchObject({ adopted: true, tabs: [{ title: "kept" }, {}] });
    expect(
      await app.evaluate(() => (Reflect.get(globalThis, "harness") as Harness).loadedAt()),
    ).toBe(loaded);
    expect(
      await app.evaluate(() => (Reflect.get(globalThis, "harness") as Harness).where()),
    ).toMatchObject({ destroyed: false, inAppWindow: true, visible: true });
  });

  it("a page that keeps crashing stops reloading and shows its crash until reloaded by hand", async () => {
    const result = await app.evaluate(() =>
      (Reflect.get(globalThis, "harness") as Harness).crashRepeatedly(3),
    );
    expect(result.crashed).toBe(true);
    expect(result.events.filter((method) => method === "ace.rendererRestarted")).toHaveLength(2);
    expect(result.events).toContain("ace.rendererCrashed");
    // The page is kept, crashed, rather than reported lost (which would make the daemon
    // recreate and reload it, crashing again).
    expect(result.events).not.toContain("Inspector.detached");
    const reloaded = await app.evaluate(() =>
      (Reflect.get(globalThis, "harness") as Harness).reload(),
    );
    expect(reloaded.crashed).toBe(false);
    expect(reloaded.events).toContain("ace.rendererRestarted");
  });
});
