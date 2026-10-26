import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { electronBinary } from "../scripts/common.ts";
import {
  appMode,
  buildApp,
  capture,
  clickMenu,
  go,
  lastOverlay,
  launch,
  scheme,
  underCaptionButtons,
  type Launched,
} from "./fixtures/desktop-chrome-app.ts";

/**
 * The Windows window chrome and OS integration, on the real app against the fake daemon:
 * caption buttons never cover ace's controls and follow its theme and zoom, Ctrl shortcut labels,
 * Help without a menu bar, monospace fonts, a second launch handing its `ace://` link to the
 * running app, and toasts. Each scale and scheme leaves full-screen captures (caption buttons and
 * taskbar included) in `dist/e2e/screens` for a person to look at. Opt in with
 * ACE_E2E_ELECTRON=1 on Windows.
 */
const enabled = process.env.ACE_E2E_ELECTRON === "1" && process.platform === "win32";
const scales = (process.env.ACE_E2E_SCALES ?? "1,1.5").split(",").map(Number);
/** `titleBarSymbolColor` in src/main/window/options.ts: glyphs for a light and a dark page. */
const darkGlyphs = "#1d1d20";
const lightGlyphs = "#e8e8ea";

describe.skipIf(!enabled)("Windows window chrome and integration", () => {
  beforeAll(buildApp);

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
        const panel = page.locator('[data-panel][data-edge="right"]');
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
          [
            "panel-open",
            async () => {
              // A thread with its side panel docked at the right: the panel's strip, not the
              // header, now meets the caption buttons.
              await page
                .getByRole("navigation", { name: "App" })
                .getByText("Fix flaky checkout test")
                .click();
              await page.waitForURL(/\/t\//, { timeout: 15_000 });
              if (!(await panel.isVisible())) await page.keyboard.press("Control+Shift+B");
              await panel.waitFor({ timeout: 15_000 });
              expect(await page.locator('[data-panel][data-docked="right"]').count()).toBe(1);
            },
          ],
          ["settings", async () => go(launched, "ace://settings/appearance")],
          ["keyboard", async () => go(launched, "ace://settings/keyboard")],
        ];
        for (const [name, enter] of views) {
          await enter();
          await page.waitForTimeout(500);
          for (const dark of [false, true]) {
            await scheme(launched, dark);
            const found = await underCaptionButtons(page);
            expect(found.overlay, "the caption-button overlay is on").toBe(true);
            problems.push(...found.hits.map((hit) => `${name}/${dark ? "dark" : "light"}: ${hit}`));
            await capture(launched, `${scale * 100}-${dark ? "dark" : "light"}-${name}`);
          }
        }
        expect(problems).toEqual([]);
      });

      // Only where the test may switch Windows' own dark mode (a disposable CI runner).
      it.runIf(process.env.GITHUB_ACTIONS === "true" && scale === 1)(
        "in System mode the page and caption buttons follow Windows between light and dark",
        async () => {
          const { page } = launched;
          const shown = () => page.evaluate(() => document.documentElement.dataset.scheme);
          await go(launched, "ace://new");
          await scheme(launched, true);
          expect(await shown()).toBe("dark");
          expect((await lastOverlay(launched)).symbolColor).toBe(lightGlyphs);
          await capture(launched, "system-mode-windows-dark");
          await scheme(launched, false);
          expect(await shown()).toBe("light");
          expect((await lastOverlay(launched)).symbolColor).toBe(darkGlyphs);
          // A reload right after a switch starts in the new scheme, not the page's stale guess.
          await scheme(launched, true);
          await page.reload();
          await page.getByRole("navigation", { name: "App" }).waitFor({ timeout: 60_000 });
          expect(await shown()).toBe("dark");
          await scheme(launched, false);
        },
      );

      it("draws the caption buttons for the page's own theme, not only the OS scheme", async () => {
        // Light app under a dark OS, then dark app under a light OS: a person's Appearance choice.
        await go(launched, "ace://new");
        await appMode(launched, "light");
        await scheme(launched, true);
        expect((await lastOverlay(launched)).symbolColor).toBe(darkGlyphs);
        await capture(launched, `${scale * 100}-os-dark-app-light`);
        await appMode(launched, "dark");
        await scheme(launched, false);
        expect((await lastOverlay(launched)).symbolColor).toBe(lightGlyphs);
        await capture(launched, `${scale * 100}-os-light-app-dark`);
        await appMode(launched, "system");
        const shown = await launched.page.evaluate(() => document.documentElement.dataset.scheme);
        expect(shown).toBe("light");
      });

      it.runIf(scale === 1)("grows the caption buttons with the page's zoom", async () => {
        const zoom = () =>
          launched.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor(),
          );
        expect(await clickMenu(launched, "Zoom In")).toBe(true);
        await launched.page.waitForTimeout(300);
        const factor = (await zoom()) ?? 1;
        expect(factor).toBeGreaterThan(1);
        expect((await lastOverlay(launched)).height).toBe(Math.round(44 * factor));
        const found = await underCaptionButtons(launched.page);
        await capture(launched, "zoomed-in");
        expect(await clickMenu(launched, "Actual Size")).toBe(true);
        await launched.page.waitForTimeout(300);
        expect((await lastOverlay(launched)).height).toBe(44);
        expect(found.hits).toEqual([]);
      });

      it.runIf(scale === 1)("labels shortcuts with Ctrl, never ⌘", async () => {
        const { page } = launched;
        await go(launched, "ace://settings/keyboard");
        await page.waitForURL(/\/settings\/keyboard$/, { timeout: 15_000 });
        await page.getByText("New thread in the current project").waitFor({ timeout: 15_000 });
        // Each key is its own chip: "Ctrl + Shift + N" reads as one chord once the gaps go.
        const text = (await page.locator("main").innerText()).replaceAll(/\s*\+\s*/g, "+");
        expect(text).toContain("New thread in the current project\nCtrl+Shift+N");
        expect(text).not.toMatch(/[⌘⌥⌃⇧]/);
      });

      it.runIf(scale === 1)(
        "offers Help, Report an issue and Show logs without a menu bar",
        async () => {
          const { page } = launched;
          await go(launched, "ace://settings/general");
          const help = page.getByRole("navigation", { name: "Help" });
          await help.waitFor({ timeout: 15_000 });
          expect(await help.getByRole("button").allInnerTexts()).toEqual([
            "Help",
            "Report an issue",
            "Show logs",
          ]);
          await help.scrollIntoViewIfNeeded();
          await capture(launched, "settings-help");
          await page.keyboard.press("Control+K");
          await page.keyboard.type("Report an issue");
          await page.getByRole("option", { name: /Report an issue/ }).waitFor({ timeout: 10_000 });
          await page.keyboard.press("Escape");
        },
      );

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
        expect(["Cascadia Mono", "Consolas"]).toContain(fonts[0]?.familyName);
      });

      it.runIf(scale === 1)("hands a second launch's ace:// link to the running app", async () => {
        const { app, page, env, args } = launched;
        await go(launched, "ace://new");
        const second = spawn(await electronBinary(), [...args, "ace://settings/notifications"], {
          env,
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

      it.runIf(scale === 1)(
        "brings ace forward from a toast button that outlived its notification",
        async () => {
          const { app } = launched;
          // Toasts are filed under the id ace sets for itself (the executable, unpackaged).
          const probe = await app.evaluate(() => {
            const probes = Reflect.get(globalThis, "__aceProbes") as {
              appUserModelId?: string;
              activation?: unknown;
            };
            return {
              id: probes.appUserModelId,
              activation: typeof probes.activation,
              exe: process.execPath,
            };
          });
          expect(probe.id).toBe(probe.exe);
          expect(probe.activation).toBe("function");
          const shown = await app.evaluate(
            ({ Notification }) =>
              new Promise<string>((resolve) => {
                const toast = new Notification({ title: "ace", body: "Windows toast check" });
                toast.once("show", () => resolve("shown"));
                toast.once("failed", (_event, error) => resolve(`failed: ${error}`));
                toast.show();
                setTimeout(() => resolve("no answer"), 10_000);
              }),
          );
          expect(shown).toBe("shown");
          await launched.page.waitForTimeout(1_500);
          await capture(launched, "toast");

          // The window put away, then Allow once pressed on a toast no live notification owns
          // (as after a restart): ace's own activation handler, as Windows calls it.
          for (const details of [
            { type: "action", arguments: "", actionIndex: 0 },
            { type: "reply", arguments: "", reply: "go ahead" },
          ]) {
            await app.evaluate(({ BrowserWindow }) => {
              const window = BrowserWindow.getAllWindows()[0];
              window?.setAlwaysOnTop(false);
              window?.minimize();
            });
            await app.evaluate((_electron, activation) => {
              const probes = Reflect.get(globalThis, "__aceProbes") as {
                activation: (details: unknown) => void;
              };
              probes.activation(activation);
            }, details);
            await launched.page.waitForTimeout(1_000);
            const window = await app.evaluate(({ BrowserWindow }) => {
              const each = BrowserWindow.getAllWindows()[0];
              return { minimized: each?.isMinimized(), visible: each?.isVisible() };
            });
            expect(window, details.type).toEqual({ minimized: false, visible: true });
          }
          // Anything that isn't a toast activation is never acted on.
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize());
          await app.evaluate(() => {
            const probes = Reflect.get(globalThis, "__aceProbes") as {
              activation: (details: unknown) => void;
            };
            probes.activation({ type: "launch", arguments: "x" });
          });
          await launched.page.waitForTimeout(1_000);
          expect(
            await app.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0]?.isMinimized(),
            ),
          ).toBe(true);
          await app.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0];
            window?.restore();
            window?.setAlwaysOnTop(true);
          });
        },
      );
    });
});
