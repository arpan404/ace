import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const out = "/tmp/ace-orch/shots/fix-real-history-import";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const theme of ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"])
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.addInitScript(
        ({ theme: appearance }) => {
          localStorage.setItem("ace.appearance", JSON.stringify({ theme: appearance }));
          Object.assign(globalThis, {
            aceFakeSetup: new Function(
              "daemon",
              `
          const history = [
            ["codex", "Find app version"], ["claude", "Fix Sitora issue 491"],
            ["opencode", "Implement missing mobile features"], ["pi", "Check reconnect retries"],
            ["codex", "Keep the useful explanation"], ["claude", "Review the attachment preview"],
          ].map(([provider,title],index) => ({id:"messy-"+index,instanceId:provider,provider,nativeId:"synthetic-"+index,
            cwd:"/Users/dev/relay",title,model:"bare-model",lastActivity:Date.now()-index*3600000,messageCount:2,
            countAccuracy:"exact",support:{status:"supported"},continuation:{status:"unsupported",reason:"Import to read this conversation."}}));
          daemon.seedServices({ history, historyScan: {state:"scanning", stats:{files:64,reads:64,bytes:12000,skipped:0},unsupported:[]},
            historyTranscripts: {"messy-0":[{role:"user",text:"Find the app version."},{role:"assistant",text:"The app version is 0.1.0. It is recorded in package.json."}]}});
        `,
            ),
          });
        },
        { theme },
      );
      await page.goto("http://127.0.0.1:5298/new?project=relay");
      await page.getByRole("button", { name: "Show all past sessions" }).click();
      const dialog = page.getByRole("dialog", { name: "Past sessions" });
      await expect(dialog.getByRole("list", { name: "Pi sessions" })).toBeVisible();
      await expect(dialog.getByText("Looking for saved conversations…")).toBeVisible();
      if (["light", "dark"].includes(theme))
        await page.screenshot({ path: `${out}/08b-scanning-${theme}-${width}.png` });
      await page.evaluate(() => {
        const ace = (
          globalThis as unknown as { ace: { daemon: { seedServices(seed: unknown): void } } }
        ).ace;
        ace.daemon.seedServices({
          historyScan: {
            state: "ready",
            stats: { files: 6000, reads: 6000, bytes: 3000000, skipped: 0 },
            unsupported: [{ instanceId: "opencode", reason: "A saved message is too large." }],
          },
        });
      });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Show all past sessions" }).click();
      await dialog.getByRole("textbox", { name: "Search past sessions" }).fill(" ");
      await expect(dialog.getByText("Looking for saved conversations…")).toHaveCount(0);
      await page.screenshot({ path: `${out}/08c-past-sessions-${theme}-${width}.png` });
      await dialog.getByRole("button", { name: "Import Find app version" }).click();
      await expect(
        page.getByRole("heading", { name: "Find app version", exact: true }),
      ).toBeVisible();
      await page.evaluate(() => {
        const ace = (
          globalThis as unknown as {
            ace: { daemon: { apply(id: string, facts: unknown[]): void } };
          }
        ).ace;
        for (const [index, text] of [
          "Native history record: event_msg",
          "Native history record: turn_context",
          "Native reasoning record",
          "",
        ].entries())
          ace.daemon.apply("past-messy-0", [
            {
              type: "item.upsert",
              agent: "root",
              item: `raw-${index}`,
              draft: {
                type: "notice",
                level: "info",
                text,
                complete: true,
                ...(text ? {} : { code: "history.raw-only" }),
                raw: [{ type: "event_msg", data: { type: "event_msg" } }],
              },
            },
          ]);
      });
      await expect(
        page
          .getByRole("feed", { name: "Transcript" })
          .getByText("The app version is 0.1.0. It is recorded in package.json."),
      ).toBeVisible();
      await expect(page.getByText("Native reasoning record", { exact: true })).toHaveCount(0);
      await page.screenshot({ path: `${out}/09-imported-session-${theme}-${width}.png` });
      if (["light", "dark"].includes(theme)) {
        if (width === 390) await page.getByRole("button", { name: "Back to threads" }).click();
        await page.getByRole("navigation", { name: "Threads" }).hover();
        await page.mouse.wheel(0, 10000);
        await page.getByRole("button", { name: /^Settled / }).click();
        await page.mouse.wheel(0, 10000);
        await expect(page.getByRole("link", { name: /^Find app version/ })).toBeVisible();
        await page.screenshot({ path: `${out}/15-settled-import-${theme}-${width}.png` });
      }
      await context.close();
      console.log(`${theme} ${width} screenshots saved`);
    }
} finally {
  await browser.close();
}
