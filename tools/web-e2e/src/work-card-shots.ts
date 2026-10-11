import { chromium, expect } from "@playwright/test";
import { workCardScenario, type FakeDaemon, type WorkCardState } from "@ace/fake-daemon";
import { mkdir, writeFile } from "node:fs/promises";

const out = "/tmp/ace-orch/shots/ui-work-card-slim";
const base = process.env.ACE_WORK_CARD_URL ?? "http://127.0.0.1:5271";
const allThemes = ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"];
const themes = process.env.ACE_WORK_CARD_THEMES?.split(",") ?? allThemes;
const states: WorkCardState[] = [
  "changes",
  "worktree",
  "merged",
  "remote",
  "many-agents",
  "failed",
];
const files: string[] = [];
const geometry: object[] = [];
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const theme of themes)
    for (const width of [1440, 390]) {
      for (const state of states) {
        const fixture = workCardScenario(state);
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        await page.addInitScript(
          ({ theme: appearance, fixture: scenario }) => {
            localStorage.setItem("ace.appearance", JSON.stringify({ theme: appearance }));
            Object.assign(globalThis, {
              aceFakeSetup: (daemon: FakeDaemon) => {
                daemon.createThread(scenario.thread);
                for (const step of scenario.steps)
                  if (step.kind === "facts") daemon.apply(scenario.thread.id, step.facts, 60000);
              },
            });
          },
          { theme, fixture },
        );
        await page.goto(`${base}/t/${fixture.thread.id}`);
        const toggle = page.getByRole("button", { name: /^Work card/ });
        await expect(toggle).toBeVisible();
        if (state === "worktree" || state === "merged" || state === "remote")
          await expect(
            page
              .getByRole("feed", { name: "Transcript" })
              .getByText(
                "Restarts now back off and stop after six attempts. The tests cover recovery after a clean restart.",
              ),
          ).toBeVisible();
        await toggle.click();
        const card = page.getByRole("complementary", { name: "Work card" });
        await expect(card.getByText("fix/restart-retry", { exact: true })).toBeVisible();
        if (state === "worktree")
          await expect(card.getByRole("button", { name: "Create PR" })).toBeVisible();
        if (state === "changes" || state === "many-agents")
          await expect(card.getByRole("region", { name: "Agents" })).toBeVisible();
        // Measure rendered geometry and scrolling, without coupling tests to utility classes.
        const bounds = await card.evaluate((node) => {
          const surface = node.querySelector<HTMLElement>("[data-work-card-surface]");
          const scroll = node.querySelector<HTMLElement>("[data-work-card-scroll]");
          if (!surface || !scroll) throw new Error("Work card didn't render");
          const box = surface.getBoundingClientRect();
          return {
            width: box.width,
            height: box.height,
            content: scroll.scrollHeight,
            viewport: scroll.clientHeight,
            x: box.x,
            y: box.y,
          };
        });
        expect(bounds.height).toBeLessThanOrEqual(width === 1440 ? 300 : 92);
        expect(bounds.width).toBe(232);
        if (state === "many-agents") expect(bounds.content).toBeGreaterThan(bounds.viewport);
        geometry.push({ theme, viewportWidth: width, state, ...bounds });
        const name = `${state}-${theme}-${width}.png`;
        await page.screenshot({ path: `${out}/${name}`, animations: "disabled" });
        await card.screenshot({ path: `${out}/card-${name}`, animations: "disabled" });
        files.push(name);
        await page.keyboard.press("Escape");
        await expect(card).toBeHidden();
        await expect(toggle).toBeFocused();
        await context.close();
        console.log(name);
      }
    }
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1560, height: 1100 } });
    await page.goto(
      `file:///Users/arpanbhandari/Code/ace-orch-state/design/workpill-${theme}.html?theme=${theme}`,
    );
    await page.screenshot({ path: `${out}/approved-${theme}.png` });
    await page.close();
  }
  await writeFile(`${out}/manifest.md`, files.map((file) => `- ${out}/${file}`).join("\n") + "\n");
  await writeFile(`${out}/geometry.json`, JSON.stringify(geometry, null, 2));
} finally {
  await browser.close();
}
