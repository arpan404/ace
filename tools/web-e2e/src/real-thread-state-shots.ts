import { chromium, expect as playwrightExpect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const out = "/tmp/ace-orch/shots/fix-real-thread-state";
const base = process.env.ACE_REAL_STATE_URL ?? "http://127.0.0.1:5240";
const presets = ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"];
const routes = [
  "legacy-notices",
  "legacy-handoff",
  "legacy-model",
  "legacy-restart",
  "legacy-send",
  "activity",
  "deleted-thread",
];
const files: string[] = [];
await mkdir(out, { recursive: true });
const expect = playwrightExpect.configure({ timeout: 30000 });
const browser = await chromium.launch();
try {
  for (const theme of presets)
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        reducedMotion: "reduce",
      });
      await context.addInitScript(
        (value) => localStorage.setItem("ace.appearance", JSON.stringify({ theme: value })),
        theme,
      );
      const page = await context.newPage();
      for (const route of theme === "light" || theme === "dark" ? routes : ["activity"]) {
        await page.goto(
          `${base}/${route === "activity" ? "activity" : `t/${route}`}?fakeWorld=real-thread-state`,
        );
        if (route === "activity") {
          await page.getByRole("tab", { name: /^Needs you/ }).click();
          await expect(
            page.getByRole("link", { name: "Check the saved message: Message not sent" }).first(),
          ).toBeVisible();
        } else if (route === "deleted-thread")
          await expect(
            page.getByRole("heading", { name: "This thread doesn't exist" }),
          ).toBeVisible();
        else {
          const feed = page.getByRole("feed", { name: "Transcript" });
          await expect(feed).toBeVisible();
          await expect(
            feed.getByText("I checked the saved conversation and kept its original messages."),
          ).toBeVisible();
          if (route === "legacy-handoff")
            await expect(feed.getByText("hi", { exact: true })).toBeVisible();
          if (route === "legacy-notices")
            await expect(
              feed.getByText("The connection timed out. Try again.", { exact: true }),
            ).toBeVisible();
          if (["legacy-model", "legacy-restart", "legacy-send"].includes(route))
            await expect(page.getByRole("list", { name: "Queued messages" })).toBeVisible();
        }
        const file = `${route}-${theme}-${width}.png`;
        await page.screenshot({ path: `${out}/${file}`, animations: "disabled" });
        files.push(file);
        console.log(file);
      }
      await context.close();
    }
  await writeFile(`${out}/manifest.md`, files.map((file) => `- ${out}/${file}`).join("\n") + "\n");
} finally {
  await browser.close();
}
