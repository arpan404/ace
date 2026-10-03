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
  (path: string, tab: string | RegExp, navigate = true): Setup =>
  async (page) => {
    if (navigate) await openThread(path)(page);
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
/** Home lands on a thread (the last opened, else the top row). */
const home: Setup = async (page) => {
  await page.goto("/");
  await page.waitForURL(/\/t\//);
  await transcript(page);
};
const visit =
  (path: string, title: string | RegExp): Setup =>
  async (page) => {
    await page.goto(path);
    await heading(page, title);
  };

/** The design's hero thread with a message queued behind the busy agent. */
async function heroWithQueue(page: Page) {
  await openThread("/t/thread-dedupe")(page);
  await page.getByRole("separator", { name: "New activity" }).waitFor();
  await page.getByRole("combobox", { name: "Message" }).fill("Also check the iOS cold-start path");
  await page.keyboard.press("Enter");
  await page.getByRole("list", { name: "Queued messages" }).waitFor();
}

const screens: Record<string, Setup> = {
  home,
  "home-hover": async (page) => {
    await home(page);
    await threadList(page).getByRole("link").nth(3).hover();
  },
  "home-settled": async (page) => {
    await home(page);
    const settled = page.getByRole("button", { name: /^Settled \(\d+\)$/ });
    await settled.scrollIntoViewIfNeeded();
    await settled.click();
    await page.getByRole("complementary", { name: "Threads" }).hover();
    await page.mouse.wheel(0, 2000);
  },
  "context-menu": async (page) => {
    await home(page);
    await threadList(page).getByRole("link").nth(4).click({ button: "right" });
    await page.getByRole("menu").waitFor();
  },
  palette: async (page) => {
    await home(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("dialog").waitFor();
  },
  "new-thread": visit("/new", "New thread"),
  // The design's hero: work log, answer, changed files, subagents, a background relay, the
  // New activity divider and a message queued behind the busy agent.
  thread: async (page) => {
    await heroWithQueue(page);
  },
  "thread-work-log": async (page) => {
    await openThread("/t/thread-dedupe")(page);
    await page.getByRole("button", { name: /^Worked for/ }).click();
  },
  // With a line comment on the diff, as the design's hero state shows.
  "thread-changes": async (page) => {
    await rightTab("/t/thread-cold-start", /^Changes/)(page);
    const file = page.getByRole("region", { name: "apps/server/src/replay.ts" });
    const line = file.getByText(/client.send\(\{ type: "resume.ack", headSeq/);
    await line.hover();
    await line.getByRole("button", { name: /^Comment on line \d+$/ }).click();
    await file
      .getByRole("textbox", { name: /Comment on line/ })
      .fill("Should the ack also carry `coldStartWindow`?");
    await file.getByRole("button", { name: "Comment", exact: true }).click();
  },
  "thread-changes-split": async (page) => {
    await rightTab("/t/thread-cold-start", /^Changes/)(page);
    await page.getByRole("button", { name: "Split" }).click();
  },
  // The same hero state as `thread`, queued message included, with the Agents tab open.
  "thread-agents": async (page) => {
    await heroWithQueue(page);
    await rightTab("/t/thread-dedupe", "Agents", false)(page);
  },
  "thread-preview": rightTab("/t/thread-cold-start", "Preview"),
  "thread-terminal": bottomTab("/t/thread-cold-start", "Terminal"),
  "thread-logs": bottomTab("/t/thread-cold-start", "Logs"),
  activity: visit("/activity", "Activity"),
  // Automations opens on the first automation.
  automations: async (page) => {
    await page.goto("/automations");
    await page.waitForURL(/\/automations\/(?!new)[^/]+$/);
    await page.getByRole("main").waitFor();
  },
  "automation-detail": async (page) => {
    await screens.automations!(page);
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

/*
 * Narrow windows, keyboard focus and reduced motion. At 390px the second sidebar is a sheet
 * opened from the header; below 1152px the panels float over the transcript instead of
 * squeezing it.
 */
const sized: Record<string, { width: number; height: number; setup: Setup }> = {
  "mobile-thread": { width: 390, height: 844, setup: openThread("/t/thread-dedupe") },
  "mobile-sidebar": {
    width: 390,
    height: 844,
    setup: async (page) => {
      await openThread("/t/thread-dedupe")(page);
      await page.getByRole("button", { name: "Show sidebar" }).click();
      await page.getByRole("dialog").getByRole("navigation", { name: "Threads" }).waitFor();
    },
  },
  "mobile-panel": {
    width: 390,
    height: 844,
    setup: rightTab("/t/thread-dedupe", "Agents"),
  },
  "tablet-thread": { width: 1024, height: 768, setup: openThread("/t/thread-dedupe") },
  "tablet-panel": { width: 1024, height: 768, setup: rightTab("/t/thread-cold-start", /^Changes/) },
  "tablet-activity": { width: 1024, height: 768, setup: visit("/activity", "Activity") },
  // Keyboard only: Tab through the rail, the list, the composer and the panel tabs.
  "focus-rail": {
    width: 1440,
    height: 900,
    setup: async (page) => {
      await openThread("/t/thread-dedupe")(page);
      await page.getByRole("navigation", { name: "Views" }).getByRole("link").first().focus();
      await page.keyboard.press("Tab");
    },
  },
  "focus-list": {
    width: 1440,
    height: 900,
    setup: async (page) => {
      await openThread("/t/thread-dedupe")(page);
      await threadList(page).getByRole("link").first().focus();
      await page.keyboard.press("Tab");
    },
  },
  "focus-composer": {
    width: 1440,
    height: 900,
    setup: async (page) => {
      await openThread("/t/thread-dedupe")(page);
      await page.getByRole("combobox", { name: "Message" }).focus();
      await page.keyboard.press("Shift+Tab");
    },
  },
  "focus-panel": {
    width: 1440,
    height: 900,
    setup: async (page) => {
      await rightTab("/t/thread-cold-start", /^Changes/)(page);
      await page.getByRole("region", { name: "Thread panel" }).getByRole("tab").first().focus();
      await page.keyboard.press("ArrowRight");
    },
  },
};

for (const [name, { width, height, setup }] of Object.entries(sized))
  test(`${name} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(() => {
      if (!localStorage.getItem("ace.appearance"))
        localStorage.setItem("ace.appearance", JSON.stringify({ theme: "dark" }));
    });
    await setup(page);
    await page.waitForTimeout(600);
    // Keyboard captures must show a focus ring on what has focus.
    if (name.startsWith("focus-"))
      expect(await page.evaluate(() => document.activeElement?.matches(":focus-visible"))).toBe(
        true,
      );
    await page.screenshot({ path: `${out}/${name}-dark.png` });
  });

test("reduced motion: panels and lists change without animating", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await rightTab("/t/thread-cold-start", "Agents")(page);
  const durations = await page.evaluate(() =>
    ["--dur-1", "--dur-2", "--dur-3", "--dur-4"].map((name) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    ),
  );
  expect(durations).toEqual(["0ms", "0ms", "0ms", "0ms"]);
  await page.screenshot({ path: `${out}/reduced-motion-dark.png` });
});
