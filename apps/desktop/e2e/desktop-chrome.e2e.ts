import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
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
import { captureScreen } from "./fixtures/screen-capture.ts";

/**
 * The Windows window chrome and OS integration, on the real app against the fake daemon:
 * caption buttons never cover ace's controls, Ctrl shortcut labels, monospace fonts, a second
 * launch handing its `ace://` link to the running app, and toasts. Each scale and scheme
 * leaves full-screen captures (caption buttons and taskbar included) in `dist/e2e/screens`
 * for a person to look at. Opt in with ACE_E2E_ELECTRON=1 on Windows.
 */
const enabled = process.env.ACE_E2E_ELECTRON === "1" && process.platform === "win32";
const out = join(desktop, "dist/e2e");
const screens = join(out, "screens");
const scales = (process.env.ACE_E2E_SCALES ?? "1,1.5").split(",").map(Number);

interface Launched {
  app: ElectronApplication;
  page: Page;
  userData: string;
  args: string[];
}

async function launch(scale: number): Promise<Launched> {
  const userData = await mkdtemp(join(tmpdir(), "ace-e2e-chrome-"));
  const args = [join(out, mainEntry), `--force-device-scale-factor=${scale}`];
  const app = await electron.launch({
    executablePath: await electronBinary(),
    args,
    env: {
      ...appEnvironment(process.env),
      ACE_DESKTOP_DAEMON: "fake",
      ACE_DESKTOP_USER_DATA: userData,
      ACE_DESKTOP_RENDERER_URL: "",
    },
  });
  app.process().stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[main] ${chunk}`));
  app.process().stderr?.on("data", (chunk: Buffer) => process.stdout.write(`[main] ${chunk}`));
  const page = await app.firstWindow();
  page.on("console", (message) => console.log(`[page ${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => console.log(`[page error] ${error.message}`));
  try {
    await page.getByRole("navigation", { name: "App" }).waitFor({ timeout: 45_000 });
  } catch (error) {
    captureScreen(join(screens, `launch-failed-${scale * 100}.png`));
    console.log(`[page url] ${page.url()}`);
    console.log(
      `[page text] ${(
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(0, 2000)}`,
    );
    throw error;
  }
  // Maximised and on top, so the screen capture shows the window and its caption buttons.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((each) => each.isVisible());
    window?.maximize();
    window?.setAlwaysOnTop(true);
    window?.focus();
  });
  return { app, page, userData, args };
}

async function go(launched: Launched, link: string): Promise<void> {
  await launched.app.evaluate(({ app }, url) => {
    app.emit("open-url", { preventDefault() {} }, url);
  }, link);
}

async function scheme(launched: Launched, dark: boolean): Promise<void> {
  await launched.app.evaluate(({ nativeTheme }, next) => {
    nativeTheme.themeSource = next ? "dark" : "light";
  }, dark);
  await launched.page.waitForTimeout(600);
}

/** Visible controls in the top bar that reach under the caption buttons. */
function underCaptionButtons(page: Page) {
  return page.evaluate(() => {
    const overlay = (
      navigator as Navigator & {
        windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect };
      }
    ).windowControlsOverlay;
    if (!overlay?.visible) return { overlay: false, hits: [] as string[] };
    const area = overlay.getTitlebarAreaRect();
    const captionStart = area.x + area.width;
    const hits: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(
      "button, a, input, [role=button], [role=tab]",
    )) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.top >= area.height || box.right <= captionStart) continue;
      if (getComputedStyle(element).visibility === "hidden") continue;
      hits.push(
        `${element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName} @ ${Math.round(box.left)}–${Math.round(box.right)} (caption from ${Math.round(captionStart)})`,
      );
    }
    return { overlay: true, hits };
  });
}

describe.skipIf(!enabled)("Windows window chrome and integration", () => {
  beforeAll(async () => {
    mkdirSync(screens, { recursive: true });
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
      { cwd: join(repo, "apps/web"), stdio: "inherit", shell: true },
    );
  });

  for (const scale of scales)
    describe(`at ${scale * 100}% scale`, () => {
      let launched: Launched;
      beforeAll(async () => {
        launched = await launch(scale);
      });
      afterAll(async () => {
        await launched?.app.close();
        if (launched?.userData) await rm(launched.userData, { recursive: true, force: true });
      });

      it("keeps every top-bar control clear of the caption buttons, light and dark", async () => {
        const { page } = launched;
        const problems: string[] = [];
        const views: [name: string, enter: () => Promise<void>][] = [
          ["home", async () => go(launched, "ace://new")],
          [
            "sidebar-hidden",
            async () => {
              await page.getByRole("button", { name: "Hide sidebar" }).click();
              await page.getByRole("button", { name: "Show sidebar" }).waitFor();
            },
          ],
          [
            "sidebar-shown",
            async () => {
              await page.getByRole("button", { name: "Show sidebar" }).click();
              await page.getByRole("button", { name: "Hide sidebar" }).waitFor();
            },
          ],
          ["settings", async () => go(launched, "ace://settings/appearance")],
          ["keyboard", async () => go(launched, "ace://settings/keyboard")],
          [
            "terminal",
            async () => {
              await go(launched, "ace://new");
              await page.keyboard.press("Control+J");
            },
          ],
        ];
        for (const [name, enter] of views) {
          await enter();
          await page.waitForTimeout(500);
          for (const dark of [false, true]) {
            await scheme(launched, dark);
            const found = await underCaptionButtons(page);
            expect(found.overlay, "the caption-button overlay is on").toBe(true);
            problems.push(...found.hits.map((hit) => `${name}/${dark ? "dark" : "light"}: ${hit}`));
            captureScreen(join(screens, `${scale * 100}-${dark ? "dark" : "light"}-${name}.png`));
          }
        }
        expect(problems).toEqual([]);
      });

      it.runIf(scale === 1)("labels shortcuts with Ctrl, never ⌘", async () => {
        const { page } = launched;
        await go(launched, "ace://settings/keyboard");
        await page.waitForTimeout(800);
        const text = await page.locator("main").innerText();
        expect(text).toContain("Ctrl+");
        expect(text).not.toMatch(/[⌘⌥⌃⇧]/);
      });

      it.runIf(scale === 1)("draws monospace text in a Windows code font", async () => {
        const { page } = launched;
        const session = await page.context().newCDPSession(page);
        await page.evaluate(() => {
          const probe = document.createElement("pre");
          probe.id = "mono-probe";
          probe.style.fontFamily = "var(--font-mono)";
          probe.textContent = "const x = 1; // 0Oo1lI";
          document.body.append(probe);
        });
        await session.send("DOM.enable");
        await session.send("CSS.enable");
        const { root } = await session.send("DOM.getDocument");
        const { nodeId } = await session.send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: "#mono-probe",
        });
        const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
        const used = fonts.map((font) => font.familyName);
        console.log(`monospace text uses: ${used.join(", ")}`);
        expect(["Cascadia Mono", "Consolas"]).toContain(used[0]);
      });

      it.runIf(scale === 1)("hands a second launch's ace:// link to the running app", async () => {
        const { app, page, userData, args } = launched;
        await go(launched, "ace://new");
        const second = spawn(await electronBinary(), [...args, "ace://settings/notifications"], {
          env: {
            ...appEnvironment(process.env),
            ACE_DESKTOP_DAEMON: "fake",
            ACE_DESKTOP_USER_DATA: userData,
            ACE_DESKTOP_RENDERER_URL: "",
          },
          stdio: "ignore",
        });
        const exited = new Promise<number | null>((resolve) => second.once("exit", resolve));
        await page.waitForURL(/\/settings\/notifications$/, { timeout: 20_000 });
        // The second process found the running app and quit instead of opening a window.
        expect(await exited).toBe(0);
        const windows = await app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        );
        expect(windows).toBe(1);
      });

      it.runIf(scale === 1)("shows a toast", async () => {
        const result = await launched.app.evaluate(
          ({ Notification }) =>
            new Promise<string>((resolve) => {
              if (!Notification.isSupported()) return resolve("unsupported");
              const toast = new Notification({ title: "ace", body: "Windows toast check" });
              toast.once("show", () => resolve("shown"));
              toast.once("failed", (_event, error) => resolve(`failed: ${error}`));
              toast.show();
              setTimeout(() => resolve("no answer"), 10_000);
            }),
        );
        expect(result).toBe("shown");
        captureScreen(join(screens, "toast.png"));
      });
    });
});
