import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import {
  appEnvironment,
  desktop,
  electronBinary,
  electronBundles,
  mainEntry,
  repo,
} from "../../scripts/common.ts";
import { captureScreen } from "./screen-capture.ts";

/**
 * The real app on a Windows desktop against the fake daemon, for `desktop-chrome.e2e.ts`: built
 * once, launched per scale with `main-probes.cjs` recording what ace hands Electron.
 */
export const out = join(desktop, "dist/e2e");
export const screens = join(out, "screens");

export interface Launched {
  app: ElectronApplication;
  page: Page;
  userData: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Main and preload as bundled for release; the renderer as Vite builds it in fake mode. */
export async function buildApp(): Promise<void> {
  mkdirSync(screens, { recursive: true });
  await Promise.all(electronBundles(out, process.env).map((options) => build(options)));
  // ACE_E2E_REUSE_BUILD=1: keep the last renderer build (quick local Windows test loops).
  if (process.env.ACE_E2E_REUSE_BUILD === "1" && existsSync(join(out, "renderer/index.html"))) return;
  // Vite's own CLI on this Node: no `bun x` shim or cmd.exe in between on Windows.
  const vite = join(
    dirname(createRequire(join(repo, "apps/web/package.json")).resolve("vite/package.json")),
    "bin/vite.js",
  );
  execFileSync(
    process.execPath,
    [
      vite,
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
}

export async function launch(scale: number): Promise<Launched> {
  const userData = await mkdtemp(join(tmpdir(), "ace-e2e-chrome-"));
  const args = [
    // Before ace's own main script: records what ace hands Electron (`main-probes.cjs`).
    "-r",
    join(import.meta.dirname, "main-probes.cjs"),
    join(out, mainEntry),
    `--force-device-scale-factor=${scale}`,
    // A CI desktop can look occluded to Chromium, which then stops drawing frames.
    "--disable-features=CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
  ];
  const env = {
    ...appEnvironment(process.env),
    ACE_DESKTOP_DAEMON: "fake",
    ACE_DESKTOP_USER_DATA: userData,
    ACE_DESKTOP_RENDERER_URL: "",
  };
  const app = await electron.launch({ executablePath: await electronBinary(), args, env });
  app.process().stderr?.on("data", (chunk: Buffer) => process.stdout.write(`[main] ${chunk}`));
  const page = await app.firstWindow();
  page.on("pageerror", (error) => console.log(`[page error] ${error.message}`));
  try {
    await page.getByRole("navigation", { name: "App" }).waitFor({ timeout: 150_000 });
  } catch (error) {
    captureScreen(join(screens, `launch-failed-${scale * 100}.png`));
    const text = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    console.log(`[page] ${page.url()}\n${text.slice(0, 2000)}`);
    throw error;
  }
  // Maximised and on top, so the screen capture shows the window and its caption buttons.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((each) => each.isVisible());
    window?.maximize();
    window?.setAlwaysOnTop(true);
    window?.focus();
  });
  return { app, page, userData, args, env };
}

/** An `ace://` link, as the OS hands it over. */
export async function go(launched: Launched, link: string): Promise<void> {
  await launched.app.evaluate(({ app }, url) => {
    app.emit("open-url", { preventDefault() {} }, url);
  }, link);
}

/** WM_SETTINGCHANGE "ImmersiveColorSet" to every top-level window, as Settings sends it. */
function broadcastColourChange(): void {
  const script = `Add-Type 'using System; using System.Runtime.InteropServices; public static class AceColours { [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr w, uint m, UIntPtr p, string l, uint f, uint t, out UIntPtr r); }'; $r = [UIntPtr]::Zero; [void][AceColours]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "ImmersiveColorSet", 2, 3000, [ref]$r)`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: "inherit",
  });
}

/**
 * The OS's light or dark mode. On a disposable CI runner, Windows' own setting, which is what a
 * person changes. Elsewhere (a shared test machine), Electron's override, which the page does
 * not see: there only the main process's side follows.
 */
export async function scheme(launched: Launched, dark: boolean): Promise<void> {
  if (process.env.GITHUB_ACTIONS === "true") {
    for (const value of ["AppsUseLightTheme", "SystemUsesLightTheme"])
      execFileSync("reg.exe", [
        "add",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
        "/v",
        value,
        "/t",
        "REG_DWORD",
        "/d",
        dark ? "0" : "1",
        "/f",
      ]);
    broadcastColourChange();
  } else
    await launched.app.evaluate(({ nativeTheme }, next) => {
      nativeTheme.themeSource = next ? "dark" : "light";
    }, dark);
  // The page follows the OS ("system" appearance) with a short cross-fade.
  await launched.page
    .waitForFunction(
      (next) => document.documentElement.dataset.scheme === next,
      dark ? "dark" : "light",
      { timeout: 5_000 },
    )
    .catch(() => {});
  await launched.page.waitForTimeout(400);
}

/** The app's own Appearance › Mode, as Settings saves it; the page reloads to read it. */
export async function appMode(
  launched: Launched,
  mode: "system" | "light" | "dark",
): Promise<void> {
  const { page } = launched;
  await page.evaluate((next) => {
    const saved: unknown = JSON.parse(localStorage.getItem("ace.appearance") ?? "{}");
    localStorage.setItem(
      "ace.appearance",
      JSON.stringify({ ...(typeof saved === "object" ? saved : {}), mode: next }),
    );
  }, mode);
  await page.reload();
  await page.getByRole("navigation", { name: "App" }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(600);
}

/**
 * A full-screen capture plus a line in `screens/report.jsonl` saying what the page and the OS
 * showed at that moment, so a capture can be read without guessing.
 */
export async function capture(launched: Launched, name: string): Promise<void> {
  captureScreen(join(screens, `${name}.png`));
  const page = await launched.page
    .evaluate(() => ({
      scheme: document.documentElement.dataset.scheme,
      background: getComputedStyle(document.body).backgroundColor,
    }))
    .catch((reason: unknown) => ({ error: String(reason) }));
  const osDark = await launched.app
    .evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
    .catch(() => undefined);
  appendFileSync(join(screens, "report.jsonl"), `${JSON.stringify({ name, osDark, ...page })}\n`);
}

/** The caption overlay as ace last set it (`main-probes.cjs`): colour and height. */
export function lastOverlay(launched: Launched) {
  return launched.app.evaluate(() => {
    const { overlays } = Reflect.get(globalThis, "__aceProbes") as {
      overlays: { symbolColor?: string; height?: number }[];
    };
    return {
      symbolColor: overlays.findLast((each) => each.symbolColor)?.symbolColor,
      height: overlays.findLast((each) => each.height)?.height,
    };
  });
}

/** Click a View-menu item by label, as choosing it with the mouse does. */
export function clickMenu(launched: Launched, label: string) {
  return launched.app.evaluate(({ BrowserWindow, Menu }, wanted) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === "View");
    const item = view?.submenu?.items.find((each) => each.label === wanted && each.visible);
    item?.click(undefined, BrowserWindow.getAllWindows()[0], undefined as never);
    return item !== undefined;
  }, label);
}

/** Visible controls in the top bar that reach under the caption buttons. */
export function underCaptionButtons(page: Page) {
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
