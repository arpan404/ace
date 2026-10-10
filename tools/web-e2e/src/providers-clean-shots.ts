import { chromium, expect as playwrightExpect, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const expect = playwrightExpect.configure({ timeout: 30_000 });
const out = "/tmp/ace-orch/shots/ui-providers-clean";
const base = process.env.ACE_PROVIDER_SHOTS_URL ?? "http://127.0.0.1:5228";
const themes = ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"];
const browser = await chromium.launch();
await mkdir(out, { recursive: true });
const files: string[] = [];
const targets = new Map<string, Buffer>();
const mock = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
for (const mode of ["light", "dark"]) {
  await mock.goto(
    `file:///Users/arpanbhandari/Code/ace-orch-state/design/providers-clean.html?theme=${mode}`,
  );
  for (let index = 0; index < 4; index++)
    targets.set(
      `${mode}-${index}`,
      await mock.locator(".pair > div:nth-child(2) .frame").nth(index).screenshot(),
    );
}
await mock.close();
const comparison = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
async function capture(page: Page, name: string, target: Buffer) {
  await page.evaluate(() => document.fonts.ready);
  const shot = await page.screenshot({ path: `${out}/${name}.png`, animations: "disabled" });
  files.push(`${name}.png`);
  await comparison.setContent(
    `<style>body{margin:0;background:#777;font:14px system-ui;color:white}main{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px}img{width:100%;object-fit:contain;object-position:top}h2{font-size:14px}</style><main><div><h2>ace · ${name}</h2><img src="data:image/png;base64,${shot.toString("base64")}"></div><div><h2>Target</h2><img src="data:image/png;base64,${target.toString("base64")}"></div></main>`,
  );
  await comparison
    .locator("img")
    .evaluateAll((images) =>
      Promise.all(
        images.map((element) =>
          element instanceof HTMLImageElement ? element.decode() : Promise.resolve(),
        ),
      ),
    );
  await comparison.screenshot({ path: `${out}/${name}-comparison.png`, fullPage: true });
  files.push(`${name}-comparison.png`);
}
try {
  for (const theme of themes)
    for (const width of [1440, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
      });
      await page.addInitScript((selected) => {
        localStorage.setItem("ace.appearance", JSON.stringify({ theme: selected }));
        Object.assign(globalThis, { aceFakeWorld: "empty" });
      }, theme);
      const mode = ["light", "paper"].includes(theme) ? "light" : "dark";
      for (const [index, surface, route] of [
        [0, "providers", "/settings/providers"],
        [1, "provider", "/settings/providers/codex"],
        [2, "add-account", "/settings/providers/codex"],
        [3, "usage", "/accounts"],
      ] as const) {
        await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
        if (index === 0)
          await expect(
            page
              .getByRole("group", { name: "Codex" })
              .getByRole("button", { name: "Update", exact: true }),
          ).toBeVisible();
        else if (index === 3)
          await expect(
            page
              .getByRole("article", { name: "Codex Personal" })
              .getByRole("meter", { name: "5-hour window" }),
          ).toBeVisible();
        else {
          await expect(
            page.getByRole("button", { name: "+ Add account", exact: true }),
          ).toBeVisible();
          await expect(page.getByRole("button", { name: /^Default model:/ })).toBeVisible();
          if (index === 2) {
            await page.getByRole("button", { name: "+ Add account", exact: true }).click();
            await expect(page.getByRole("textbox", { name: "Account name" })).toBeFocused();
            await page.getByRole("textbox", { name: "Account name" }).fill("Work");
          }
        }
        const target = targets.get(`${mode}-${index}`);
        if (!target) throw new Error("Missing target screenshot");
        await capture(page, `${surface}-${theme}-${width}`, target);
        if (index === 2 && ["light", "dark"].includes(theme)) {
          await page.getByRole("button", { name: "Add and sign in" }).click();
          await expect(page.getByLabel("Sign-in code")).toBeVisible();
          await capture(page, `add-waiting-${theme}-${width}`, target);
          await page.evaluate(() =>
            new Function("ace.daemon.services.providerLogin.complete('fake-login-1', false)")(),
          );
          await expect(page.getByRole("button", { name: /Try again|Retry/ })).toBeVisible();
          await capture(page, `add-failure-${theme}-${width}`, target);
          await page.getByRole("button", { name: /Try again|Retry/ }).click();
          await expect(page.getByLabel("Sign-in code")).toBeVisible();
          await page.evaluate(() =>
            new Function("ace.daemon.services.providerLogin.complete('fake-login-2')")(),
          );
          await expect(page.getByRole("dialog", { name: "Add a Codex account" })).toHaveCount(0);
          await expect(
            page.getByRole("list", { name: "Codex accounts" }).getByText("Work", { exact: true }),
          ).toBeVisible();
          await capture(page, `add-success-${theme}-${width}`, targets.get(`${mode}-1`) ?? target);
        }
        await expect
          .poll(() =>
            page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          )
          .toBe(true);
      }
      if (["light", "dark"].includes(theme)) {
        await page.goto(`${base}/settings/providers/codex`, {
          waitUntil: "domcontentloaded",
          timeout: 180_000,
        });
        const target = targets.get(`${mode}-1`);
        if (!target) throw new Error("Missing provider target");
        const personal = page
          .getByRole("list", { name: "Codex accounts" })
          .getByRole("listitem")
          .filter({ has: page.getByText("Personal", { exact: true }) });
        await personal.hover();
        await expect(personal.getByRole("button", { name: "Make default" })).toBeVisible();
        await capture(page, `account-hover-${theme}-${width}`, target);
        await personal.getByRole("button", { name: "Manage Personal" }).click();
        await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
        await capture(page, `account-menu-${theme}-${width}`, target);
        await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Remove Personal?" })).toBeVisible();
        await capture(page, `account-remove-${theme}-${width}`, target);
        await page
          .getByRole("dialog", { name: "Remove Personal?" })
          .getByRole("button", { name: "Cancel" })
          .click();
        await page.getByRole("button", { name: "Manage", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Manage models" })).toBeVisible();
        await capture(page, `models-${theme}-${width}`, target);
        await page.keyboard.press("Escape");
        await page.locator("summary").filter({ hasText: "Advanced" }).click();
        await expect(page.getByRole("textbox", { name: "CLI path" })).toBeVisible();
        await capture(page, `advanced-${theme}-${width}`, target);
      }
      await page.close();
      process.stdout.write(`Captured ${theme} ${width}\n`);
    }
  // Contact sheets make reviewing every theme and viewport practical.
  for (const surface of ["providers", "provider", "add-account", "usage"]) {
    const names = files.filter(
      (file) => file.startsWith(`${surface}-`) && !file.includes("comparison"),
    );
    const entries = await Promise.all(
      names.map(
        async (file) =>
          `<div><p>${file}</p><img src="data:image/png;base64,${(await readFile(`${out}/${file}`)).toString("base64")}"></div>`,
      ),
    );
    await comparison.setViewportSize({ width: 2000, height: 1800 });
    await comparison.setContent(
      `<style>body{margin:0;background:#777;color:white;font:14px system-ui}main{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}img{width:100%;height:400px;object-fit:contain;object-position:top}p{margin:8px}</style><main>${entries.join("")}</main>`,
    );
    await comparison
      .locator("img")
      .evaluateAll((images) =>
        Promise.all(
          images.map((element) =>
            element instanceof HTMLImageElement ? element.decode() : Promise.resolve(),
          ),
        ),
      );
    await comparison.screenshot({ path: `${out}/${surface}-review.png`, fullPage: true });
  }
  await writeFile(
    `${out}/screenshots.md`,
    files.map((file) => `- ${out}/${file}`).join("\n") + "\n",
  );
} finally {
  await browser.close();
}
