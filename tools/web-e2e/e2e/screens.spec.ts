import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Renders every screen against the fake daemon in Dark and Light at 1440x900 to
 * /tmp/aceshots-web/<screen>-<theme>.png, for comparison with the approved prototype.
 * Run on demand: `bun run --filter @ace/web-e2e screens`.
 */
const out = process.env.ACE_SHOTS_DIR ?? "/tmp/aceshots-web";
mkdirSync(out, { recursive: true });

type Setup = (page: Page) => Promise<void>;
const heading = (page: Page, name: string | RegExp) =>
  expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
const threadList = (page: Page) => page.getByRole("navigation", { name: "Threads" });
const transcript = (page: Page) => page.getByRole("feed", { name: "Transcript" }).waitFor();
const openThread =
  (path: string): Setup =>
  async (page) => {
    await page.goto(path);
    await transcript(page);
  };
const rightTab =
  (path: string, tab: string | RegExp): Setup =>
  async (page) => {
    await openThread(path)(page);
    const panel = page.getByRole("region", { name: "Thread panel" });
    if (!(await panel.isVisible())) await page.getByRole("button", { name: "Right panel" }).click();
    await panel.getByRole("tab", { name: tab }).click();
  };
const bottomTab =
  (path: string, tab: string): Setup =>
  async (page) => {
    await openThread(path)(page);
    await page.getByRole("button", { name: "Bottom panel" }).click();
    await page
      .getByRole("region", { name: "Bottom panel" })
      .getByRole("tab", { name: tab })
      .click();
  };
const visit =
  (path: string, title: string | RegExp): Setup =>
  async (page) => {
    await page.goto(path);
    await heading(page, title);
  };

const screens: Record<string, Setup> = {
  home: visit("/", "Home"),
  "home-hover": async (page) => {
    await visit("/", "Home")(page);
    await threadList(page).getByRole("link").nth(3).hover();
  },
  "home-settled": async (page) => {
    await visit("/", "Home")(page);
    const settled = page.getByRole("button", { name: /^Settled \(\d+\)$/ });
    await settled.scrollIntoViewIfNeeded();
    await settled.click();
    await page.getByRole("complementary", { name: "Threads" }).hover();
    await page.mouse.wheel(0, 2000);
  },
  "context-menu": async (page) => {
    await visit("/", "Home")(page);
    await threadList(page).getByRole("link").nth(4).click({ button: "right" });
    await page.getByRole("menu").waitFor();
  },
  palette: async (page) => {
    await visit("/", "Home")(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("dialog").waitFor();
  },
  "new-thread": visit("/new", "New thread"),
  thread: openThread("/t/thread-replay-cursor"),
  "thread-work-log": async (page) => {
    await openThread("/t/thread-replay-cursor")(page);
    await page.getByRole("button", { name: /^Worked for/ }).click();
  },
  "thread-changes": rightTab("/t/thread-cold-start", /^Changes/),
  "thread-changes-split": async (page) => {
    await rightTab("/t/thread-cold-start", /^Changes/)(page);
    await page.getByRole("button", { name: "Split" }).click();
  },
  "thread-agents": rightTab("/t/thread-replay-cursor", "Agents"),
  "thread-preview": rightTab("/t/thread-cold-start", "Preview"),
  "thread-terminal": bottomTab("/t/thread-cold-start", "Terminal"),
  "thread-logs": bottomTab("/t/thread-cold-start", "Logs"),
  activity: visit("/activity", "Activity"),
  automations: visit("/automations", "Automations"),
  "automation-detail": async (page) => {
    await visit("/automations", "Automations")(page);
    await page
      .getByRole("complementary")
      .locator('a[href^="/automations/"]:not([href$="/new"])')
      .first()
      .click();
    await page.waitForURL(/\/automations\/(?!new)[^/]+$/);
    await page.getByRole("main").waitFor();
  },
  "automation-new": visit("/automations/new", /New automation/),
  deck: visit("/deck", "Resumable relay streams"),
  "deck-lanes": async (page) => {
    await visit("/deck", "Resumable relay streams")(page);
    await page.getByRole("button", { name: "Lanes" }).click();
  },
  "deck-new": visit("/deck/new", "New deck"),
  // Skills opens on the first catalog entry.
  skills: async (page) => {
    await page.goto("/skills");
    await page.waitForURL(/\/skills\/.+/);
    await page.getByRole("main").waitFor();
  },
  "skill-detail": async (page) => {
    await screens.skills!(page);
    await page.getByRole("complementary").locator('a[href^="/skills/"]').nth(2).click();
    await page.getByRole("main").waitFor();
  },
  accounts: visit("/more", "Usage & accounts"),
  files: visit("/more/files", "Files"),
  search: visit("/more/search?q=replay", "Search"),
  "settings-general": visit("/settings/general", "Settings"),
  "settings-appearance": visit("/settings/appearance", "Settings"),
  "settings-providers": visit("/settings/providers", "Settings"),
  "settings-notifications": visit("/settings/notifications", "Settings"),
  "settings-remote": visit("/settings/remote", "Settings"),
  "settings-keyboard": visit("/settings/keyboard", "Settings"),
  "settings-advanced": visit("/settings/advanced", "Settings"),
  "settings-theme-editor": visit("/settings/theme-editor", "Settings"),
};

for (const theme of ["dark", "light"] as const)
  for (const [name, setup] of Object.entries(screens))
    test(`${name} in ${theme}`, async ({ page }) => {
      await page.addInitScript((id) => {
        if (!localStorage.getItem("ace.appearance"))
          localStorage.setItem("ace.appearance", JSON.stringify({ theme: id }));
      }, theme);
      await setup(page);
      // Let entrance transitions and live scenarios settle before the capture.
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${out}/${name}-${theme}.png` });
    });
