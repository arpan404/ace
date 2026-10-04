import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appEnvironment,
  desktop,
  electronBinary,
  electronBundles,
  mainEntry,
  repo,
} from "../scripts/common.ts";

/**
 * Launches the real Electron app against the in-page fake daemon: main and preload as
 * bundled for release, the renderer built in fake mode and served from `app://ace/` with the
 * production CSP. Opt in with ACE_E2E_ELECTRON=1 (`bun run desktop:e2e`).
 */
const enabled = process.env.ACE_E2E_ELECTRON === "1";
const out = join(desktop, "dist/e2e");
let app: ElectronApplication;
let page: Page;
let userData: string;

describe.skipIf(!enabled)("desktop app (fake daemon)", () => {
  beforeAll(async () => {
    await Promise.all(electronBundles(out, process.env).map((options) => build(options)));
    execFileSync(
      "bun",
      [
        "x",
        "vite",
        "build",
        "--mode",
        "fake",
        "--outDir",
        join(out, "renderer"),
        "--emptyOutDir",
        "--logLevel",
        "warn",
      ],
      { cwd: join(repo, "apps/web"), stdio: "inherit" },
    );
    userData = await mkdtemp(join(tmpdir(), "ace-e2e-"));
    app = await electron.launch({
      executablePath: await electronBinary(),
      args: [join(out, mainEntry)],
      env: {
        ...appEnvironment(process.env),
        ACE_DESKTOP_DAEMON: "fake",
        ACE_DESKTOP_USER_DATA: userData,
        ACE_DESKTOP_RENDERER_URL: "",
      },
    });
    page = await app.firstWindow();
  });

  afterAll(async () => {
    await app?.close();
    if (userData) await rm(userData, { recursive: true, force: true });
  });

  it("renders the app shell from the bundled renderer", async () => {
    await page.getByRole("navigation", { name: "Views" }).waitFor({ timeout: 30_000 });
    expect(new URL(page.url()).protocol).toBe("app:");
    // The page may render its heading a frame after the sidebar; wait for it to be visible.
    await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 15_000 });
  });

  it.runIf(process.platform === "darwin")(
    "keeps the sidebar, its Home link as icons, and the header with it hidden clear of the traffic lights",
    async () => {
      // The traffic lights end 68 px from the window's left edge.
      const home = page.getByRole("link", { name: "Home", exact: true });
      expect((await home.boundingBox())?.x).toBeGreaterThanOrEqual(68);
      await page.getByRole("button", { name: "Hide sidebar" }).click();
      const show = page.getByRole("button", { name: "Show sidebar" });
      await show.waitFor();
      expect((await show.boundingBox())?.x).toBeGreaterThanOrEqual(68);
      await show.click();
      await home.waitFor();

      // As icons, Home sits below the traffic lights (which end 28 px from the top) and works.
      await page.getByRole("link", { name: "Activity", exact: false }).first().click();
      await page.getByRole("button", { name: "Collapse sidebar" }).click();
      await page.getByRole("button", { name: "Expand sidebar" }).waitFor();
      const box = await home.boundingBox();
      expect(box?.y).toBeGreaterThanOrEqual(28);
      await expect.poll(() => home.isVisible()).toBe(true);
      await home.click();
      await expect.poll(() => new URL(page.url()).pathname).not.toBe("/activity");
      await page.getByRole("button", { name: "Expand sidebar" }).click();
      await page.getByRole("button", { name: "Collapse sidebar" }).waitFor();
    },
  );

  it("exposes a working window.ace bridge and no Node APIs", async () => {
    const result = await page.evaluate(async () => {
      const bridge = (
        globalThis as unknown as { ace: import("../src/preload/bridge.ts").AceBridge }
      ).ace;
      const connection = await bridge.daemon.connection();
      const settings = await bridge.settings.get();
      const updated = await bridge.settings.update({ attention: false });
      const refused = await bridge.shell.openExternal("file:///etc/passwd").then(
        () => "sent",
        (error: unknown) => (error instanceof Error ? error.message : "error"),
      );
      return {
        version: bridge.version,
        platform: bridge.platform,
        connection,
        background: settings.background,
        attention: updated.attention,
        refused,
        node: typeof (globalThis as { require?: unknown }).require,
        process: typeof (globalThis as { process?: unknown }).process,
      };
    });
    expect(result).toMatchObject({
      platform: process.platform,
      connection: { mode: "fake" },
      background: true,
      attention: false,
      refused: expect.stringContaining("Invalid shell.openExternal request"),
      node: "undefined",
      process: "undefined",
    });
    expect(result.version).toBe(
      JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")).version,
    );
  });

  it("follows an ace:// deep link to the right screen", async () => {
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit("open-url", { preventDefault() {} }, "ace://settings/appearance");
    });
    await page.waitForURL(/\/settings\/appearance$/, { timeout: 15_000 });
  });

  it("keeps navigation inside the app", async () => {
    const before = page.url();
    await page.evaluate(() => {
      location.href = "https://example.com/";
    });
    await page.waitForTimeout(500);
    expect(page.url()).toBe(before);
  });
});
