import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const out = "/tmp/ace-orch/shots/fix-history-memory";
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
      await page.goto("http://127.0.0.1:5298/setup");
      await page.getByRole("button", { name: "Get started" }).click();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByText("Bring an existing conversation").click();
      await page.getByRole("combobox", { name: "Past sessions project" }).click();
      await page.getByRole("option", { name: "relay", exact: true }).click();
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
            state: "retrying",
            stats: { files: 6000, reads: 6000, bytes: 710587403, skipped: 0 },
            unsupported: [],
          },
        });
      });
      await expect(dialog.getByText("Past sessions will be back shortly. Retrying…")).toBeVisible();
      await page.screenshot({ path: `${out}/08a-retrying-${theme}-${width}.png` });
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
          "Native history record: message",
          "Native history record: world_state",
          "Native content block: input_image",
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
      await page.evaluate((image) => {
        const ace = (
          globalThis as unknown as {
            ace: { daemon: { apply(id: string, facts: unknown[]): void } };
          }
        ).ace;
        ace.daemon.apply("past-messy-0", [
          {
            type: "item.upsert",
            agent: "root",
            item: "attached-image",
            draft: {
              type: "message",
              role: "user",
              complete: true,
              parts: [
                { type: "text", text: "Check the version in this screenshot." },
                { type: "image", mimeType: "image/png", url: image },
              ],
              raw: [],
            },
          },
        ]);
      }, "data:image/png;base64,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");
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
