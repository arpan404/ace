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
    const existing = panel.getByRole("tab", { name: tab });
    if (await existing.count()) return existing.click();
    // A tool not open yet comes from the side panel's + (the new-tab launcher).
    await panel.getByRole("button", { name: "New tab" }).click();
    await panel
      .getByRole("list", { name: "Tools" })
      .getByRole("button", { name: typeof tab === "string" ? new RegExp(`^${tab}`) : tab })
      .click();
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
/**
 * Home lands on a thread (the last opened, else the top row). The design's hero was the last
 * one opened here; the top rows are a running deck's lanes.
 */
const home: Setup = async (page) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("ace.home.lastThread"))
      localStorage.setItem("ace.home.lastThread", JSON.stringify("thread-dedupe"));
  });
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

/**
 * Stage the fake daemon before the app's first request: `aceFakeSetup` runs in the fake boot
 * with the daemon (failing or holding requests, emptying scripts, requiring a download).
 */
const staged =
  (stage: string, then: Setup): Setup =>
  async (page) => {
    await page.addInitScript((body) => {
      Object.assign(globalThis, { aceFakeSetup: new Function("daemon", body) });
    }, stage);
    await then(page);
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
    // The list is virtual: Settled is rendered once it scrolls into view.
    const settled = page.getByRole("button", { name: /^Settled \(\d+\)$/ });
    await page.getByRole("complementary", { name: "Threads" }).hover();
    while (!(await settled.isVisible())) await page.mouse.wheel(0, 600);
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
    // Send to agent appears under the pointer; move away so it shows at rest, not hovered.
    await page.mouse.move(700, 880);
  },
  // The same line comment, after switching the diff to Split.
  "thread-changes-split": async (page) => {
    await screens["thread-changes"]?.(page);
    await page.getByRole("button", { name: /^Diff layout/ }).click();
    await page.getByRole("menuitemradio", { name: /^Split/ }).click();
    await page.getByRole("article", { name: /Comment on line/ }).waitFor();
  },
  // The review in progress: one comment sent to the agent, another resolved, the files tree.
  "thread-changes-review": async (page) => {
    await screens["thread-changes"]?.(page);
    const panel = page.getByRole("region", { name: "Thread panel" });
    await panel
      .getByRole("region", { name: "Review" })
      .getByRole("button", { name: /^Send/ })
      .click();
    await panel.getByRole("button", { name: "Resolve" }).waitFor();
    await page.mouse.move(700, 880);
  },
  // A subagent opened from the tree: delegation, its own transcript, the follow-up it can't take.
  "thread-agent-tab": async (page) => {
    await rightTab("/t/thread-cold-start", "Agents")(page);
    const panel = page.getByRole("region", { name: "Thread panel" });
    await panel.getByRole("treeitem", { name: /^resume-sweep:/ }).click();
    await panel.getByRole("region", { name: "Delegation" }).waitFor();
  },
  // ace's risk policy approving, denying and escalating, the denial opened to its target.
  "thread-permission-review": async (page) => {
    await openThread("/t/thread-release-audit")(page);
    const denied = page.getByRole("article", { name: "Permission review: Denied by ace" });
    await denied.getByRole("button").click();
    await denied.getByText("rm -rf dist").waitFor();
  },
  // A dev server in a Preview tab of its own.
  "thread-port-tab": async (page) => {
    await rightTab("/t/thread-install-page", "Preview")(page);
    const panel = page.getByRole("region", { name: "Thread panel" });
    await panel.getByRole("textbox", { name: "Dev server port" }).fill("4173");
    await panel.getByRole("button", { name: "Preview", exact: true }).click();
    await panel.getByRole("button", { name: "Open in its own tab" }).click();
    await panel.getByRole("textbox", { name: "Address" }).waitFor();
  },
  // The same hero state as `thread`, queued message included, with the Agents tab open.
  "thread-agents": async (page) => {
    await heroWithQueue(page);
    await rightTab("/t/thread-dedupe", "Agents", false)(page);
  },
  // The side panel's + : the tool catalog and what the thread suggests opening.
  "thread-launcher": async (page) => {
    await rightTab("/t/thread-cold-start", /^Changes/)(page);
    const panel = page.getByRole("region", { name: "Thread panel" });
    await panel.getByRole("button", { name: "New tab" }).click();
    await panel.getByRole("list", { name: "Tools" }).waitFor();
  },
  // The side panel hidden: the header counts its tabs and lists them on hover.
  "thread-open-tabs": async (page) => {
    await rightTab("/t/thread-cold-start", "Preview")(page);
    await page.getByRole("button", { name: "Right panel" }).click();
    // Hover once the panel has gone and the header has its full width back.
    await expect(page.getByRole("region", { name: "Thread panel" })).toHaveCount(0);
    // The header's actions unfold into the room the panel left; let that settle first.
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: /^Open tabs:/ }).hover();
    await page.getByRole("list", { name: "Open tabs" }).waitFor();
  },
  // Full view: the side panel fills the work area, with a way back to the conversation.
  "thread-full-view": async (page) => {
    await rightTab("/t/thread-cold-start", /^Changes/)(page);
    await page.getByRole("button", { name: "Full view" }).click();
    await page.getByRole("button", { name: /Cap cold-start replay/ }).waitFor();
  },
  "thread-summary": async (page) => {
    await openThread("/t/thread-dedupe")(page);
    await page.getByRole("button", { name: "Pin thread summary" }).click();
    await page
      .getByRole("complementary", { name: "Thread summary" })
      .getByRole("button", { name: "Open reconnect-audit" })
      .waitFor();
  },
  // The summary's project and git menu.
  "thread-summary-menu": async (page) => {
    await screens["thread-summary"]?.(page);
    await page.getByRole("button", { name: "Project and git actions" }).click();
    await page.getByRole("menu").waitFor();
  },
  "thread-preview": rightTab("/t/thread-cold-start", "Preview"),
  // Nothing to preview yet: open a browser, or preview a dev server by its port.
  "thread-preview-empty": rightTab("/t/thread-install-page", "Preview"),
  // Files: an empty file tab, ⌘P quick open, and a file beside the checkout tree.
  "thread-files-empty": rightTab("/t/thread-cold-start", "Files"),
  "thread-quick-open": async (page) => {
    await openThread("/t/thread-cold-start")(page);
    await page.keyboard.press("ControlOrMeta+p");
    await page.getByRole("combobox", { name: "Search files" }).fill("replay");
    await page.getByRole("option").first().waitFor();
  },
  "thread-file": async (page) => {
    await openThread("/t/thread-cold-start")(page);
    await page.keyboard.press("ControlOrMeta+p");
    await page.getByRole("combobox", { name: "Search files" }).fill("replay.ts");
    await page.getByRole("option", { name: /replay\.ts/ }).waitFor();
    await page.keyboard.press("Enter");
    const panel = page.getByRole("region", { name: "Thread panel" });
    await panel.getByRole("region", { name: "Source of apps/server/src/replay.ts" }).waitFor();
    await panel.getByRole("button", { name: "Show the file tree" }).click();
    await panel.getByRole("complementary", { name: "Checkout files" }).waitFor();
  },
  // Browser: a page loaded from the new tab's address bar.
  "thread-browser": async (page) => {
    await rightTab("/t/thread-cold-start", /^Changes/)(page);
    const panel = page.getByRole("region", { name: "Thread panel" });
    await panel.getByRole("button", { name: "New tab" }).click();
    const address = panel.getByRole("combobox", { name: "Address" });
    await address.fill("docs.example.com/guide");
    await address.press("Enter");
    await panel.getByRole("img", { name: "Live view of https://docs.example.com/guide" }).waitFor();
  },
  "thread-side-chat": rightTab("/t/thread-cold-start", "Side chat"),
  // The composer: its + menu, approvals and model menus, three lines, and an attachment.
  "composer-add-menu": async (page) => {
    await openThread("/t/thread-replay-cursor")(page);
    await page.getByRole("button", { name: "Add files and context" }).click();
    await page.getByRole("menuitem", { name: /^Files/ }).waitFor();
  },
  "composer-approvals": async (page) => {
    await openThread("/t/thread-replay-cursor")(page);
    await page.getByRole("button", { name: /^Approvals:/ }).click();
    await page.getByRole("menuitemradio").first().waitFor();
  },
  "composer-model": async (page) => {
    await openThread("/t/thread-replay-cursor")(page);
    await page.getByRole("button", { name: /^Model:/ }).click();
    await page.getByRole("menu").waitFor();
  },
  "composer-multiline": async (page) => {
    await openThread("/t/thread-replay-cursor")(page);
    await page
      .getByRole("combobox", { name: "Message" })
      .fill(
        "Check the cold-start path before merging\nthen rerun the relay soak\nand post the numbers here",
      );
  },
  "composer-attachments": async (page) => {
    await openThread("/t/thread-replay-cursor")(page);
    await page.getByRole("combobox", { name: "Message" }).fill("See the relay log");
    await page.getByLabel("Files to attach").setInputFiles({
      name: "relay.log",
      mimeType: "text/plain",
      buffer: Buffer.from("2026-10-03 resume seq 0"),
    });
    await page.getByRole("list", { name: "Attachments" }).getByText("relay.log").waitFor();
  },
  "thread-terminal-new": async (page) => {
    await bottomTab("/t/thread-cold-start", "zsh")(page);
    const bottom = page.getByRole("region", { name: "Bottom panel" });
    await bottom.getByRole("button", { name: "New terminal" }).click();
    await bottom.getByRole("tab", { name: "zsh 2", selected: true }).waitFor();
    await page.keyboard.type("git status");
    await page.keyboard.press("Enter");
  },
  // A thread stopped at its account's usage limit, with the recovery choices.
  "thread-limited": async (page) => {
    await openThread("/t/thread-limit-search")(page);
    await page.getByRole("region", { name: "Usage limit reached" }).waitFor();
  },
  // A queued message's options: Send now, Edit, Move, Remove.
  "thread-queue-menu": async (page) => {
    await heroWithQueue(page);
    await page.getByRole("button", { name: /^Queued message options:/ }).click();
    await page.getByRole("menu").waitFor();
  },
  "thread-devices": async (page) => {
    await rightTab("/t/thread-install-page", "Devices")(page);
    const panel = page.getByRole("region", { name: "Thread panel" });
    await panel.getByRole("button", { name: "Enable devices" }).click();
    await panel
      .getByRole("list", { name: "Devices" })
      .getByRole("button", { name: /iPhone 16 Pro/ })
      .click();
    const phone = panel.getByRole("region", { name: "iPhone 16 Pro" });
    await phone.getByRole("button", { name: "Start live view" }).click();
    await phone.getByRole("img", { name: "iPhone 16 Pro screen" }).waitFor();
  },
  "thread-devices-off": rightTab("/t/thread-install-page", "Devices"),
  "thread-git-menu": async (page) => {
    await openThread("/t/thread-retry-budget")(page);
    await page.getByRole("button", { name: "Git actions" }).click();
    await page.getByRole("menu", { name: "Git actions" }).waitFor();
  },
  "thread-commit": async (page) => {
    await openThread("/t/thread-retry-budget")(page);
    await page.getByRole("button", { name: "Commit", exact: true }).click();
    await page.getByRole("dialog", { name: "Commit changes" }).waitFor();
  },
  "thread-create-pr": async (page) => {
    await openThread("/t/thread-sheet-rotate")(page);
    await page.getByRole("button", { name: "Create PR" }).click();
    await page.getByRole("dialog", { name: "Open a pull request" }).waitFor();
  },
  "thread-run-menu": async (page) => {
    await openThread("/t/thread-replay-cursor")(page);
    await page.getByRole("button", { name: "Choose a script" }).click();
    await page.getByRole("menu").waitFor();
  },
  "thread-menu": async (page) => {
    await openThread("/t/thread-install-page")(page);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menu", { name: "More actions" }).waitFor();
  },
  // The bottom panel's terminal picks up the thread's running zsh.
  "thread-terminal": bottomTab("/t/thread-cold-start", "zsh"),
  "thread-terminal-sessions": async (page) => {
    await bottomTab("/t/thread-cold-start", "zsh")(page);
    await page.getByRole("button", { name: /^Terminal sessions/ }).click();
    await page.getByRole("menu").waitFor();
  },
  "thread-agent-shell": async (page) => {
    await bottomTab("/t/thread-cold-start", "zsh")(page);
    await page.getByRole("button", { name: /^Terminal sessions/ }).click();
    await page.getByRole("menuitem", { name: /relay:soak/ }).click();
    await page.getByText("Agent shell").waitFor();
  },
  // A script started from Run, in its own terminal tab.
  "thread-terminal-run": async (page) => {
    await openThread("/t/thread-replay-cursor")(page);
    await page.getByRole("button", { name: "Run bun run dev:relay" }).click();
    await page
      .getByRole("region", { name: "Bottom panel" })
      .getByRole("tab", { name: "dev:relay" })
      .waitFor();
  },
  "thread-logs": bottomTab("/t/thread-cold-start", "Logs"),
  "thread-logs-daemon": async (page) => {
    await bottomTab("/t/thread-cold-start", "Logs")(page);
    await page.getByRole("button", { name: /^Log source/ }).click();
    await page.getByRole("menuitemradio", { name: "Daemon" }).click();
    await page.getByText("Event loop").waitFor();
  },
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
  "deck-escalation": visit("/deck/mobile-cold-start", "Mobile cold start under 1s"),
  "deck-question": async (page) => {
    await visit("/deck/mobile-cold-start", "Mobile cold start under 1s")(page);
    await page
      .getByRole("region", { name: "Escalated: Defer the first relay sync" })
      .getByRole("button", { name: "Retry card" })
      .click();
    await page
      .getByRole("region", { name: "Precompile Hermes bytecode needs your answer" })
      .getByRole("radio")
      .first()
      .waitFor();
  },
  "deck-running": async (page) => {
    await screens["deck-question"]!(page);
    const asking = page.getByRole("region", {
      name: "Precompile Hermes bytecode needs your answer",
    });
    await asking.getByRole("radio", { name: "Ship it in the APK" }).click();
    await asking.getByRole("button", { name: "Answer" }).click();
    await asking.waitFor({ state: "detached" });
    await page.getByRole("button", { name: /^Lazy-load fonts and icons/ }).click();
  },
  "deck-done": visit("/deck/codex-app-server-048", "Codex app-server 0.48"),
  "deck-cancelled": async (page) => {
    await visit("/deck/mobile-cold-start", "Mobile cold start under 1s")(page);
    await page.getByRole("button", { name: "More actions" }).first().click();
    await page.getByRole("menuitem", { name: "Cancel deck…" }).click();
    await page
      .getByRole("dialog", { name: "Cancel this deck?" })
      .getByRole("button", { name: "Cancel deck" })
      .click();
    await page.getByText("This deck was cancelled.").waitFor();
  },
  "deck-stopped": staged(
    'daemon.failDeck("mobile-cold-start", "deck_workspace_not_found");',
    async (page) => {
      await visit("/deck/mobile-cold-start", "Mobile cold start under 1s")(page);
      await page.getByText("The deck can't take its next step.").waitFor();
    },
  ),
  // Decks the design's world doesn't hold, staged on the fake conductor.
  "deck-budget": staged(
    'daemon.servicesWire.planning.conductor.stage("budget");',
    visit("/deck/settings-sync", "Sync settings across devices"),
  ),
  "deck-unresponsive": staged(
    'daemon.servicesWire.planning.conductor.stage("unresponsive");',
    visit("/deck/export-threads", "Export threads as Markdown"),
  ),
  "deck-plan-review": staged(
    'daemon.servicesWire.planning.conductor.stage("planning");',
    async (page) => {
      await visit("/deck/search-ranking", "Rank search results by recency")(page);
      await page.getByRole("button", { name: "Review plan" }).click();
      await page.getByRole("dialog", { name: "The deck's plan" }).waitFor();
    },
  ),
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

  // Offline, disconnected, loading and failure states, so they can be checked for intent.
  "state-offline": async (page) => {
    await openThread("/t/thread-dedupe")(page);
    // The network goes away under the client (what the page's offline event does in a real
    // connection); the dev server stays reachable for lazy modules.
    await page.evaluate(() =>
      (
        globalThis as unknown as { ace: { client: { networkOnline(online: boolean): void } } }
      ).ace.client.networkOnline(false),
    );
    await page.getByText(/^Offline\./).waitFor();
  },
  "state-reconnecting": async (page) => {
    await openThread("/t/thread-dedupe")(page);
    await page.evaluate(() =>
      (
        globalThis as unknown as { ace: { daemon: { refuseConnections(on: boolean): void } } }
      ).ace.daemon.refuseConnections(true),
    );
    await page.getByText("Reconnecting to the daemon…").waitFor();
  },
  "state-devices-disconnected": async (page) => {
    await rightTab("/t/thread-install-page", "Devices")(page);
    const panel = page.getByRole("region", { name: "Thread panel" });
    await panel.getByRole("button", { name: "Enable devices" }).waitFor();
    await page.evaluate(() =>
      (
        globalThis as unknown as { ace: { daemon: { appDevices: { dropAll(): void } } } }
      ).ace.daemon.appDevices.dropAll(),
    );
    await panel.getByRole("button", { name: "Reconnect" }).waitFor();
  },
  "state-run-no-scripts": staged('daemon.setScripts("relay", []);', async (page) => {
    await openThread("/t/thread-replay-cursor")(page);
    await page.getByRole("button", { name: "Choose a script" }).click();
    await page.getByRole("menuitem", { name: /No scripts in this project/ }).waitFor();
  }),
  "state-accounts-loading": staged('daemon.holdRequests("accounts.list");', async (page) => {
    await visit("/more", "Usage & accounts")(page);
    await page.getByRole("status", { name: /Loading accounts/ }).waitFor();
  }),
  "state-accounts-error": staged('daemon.failRequests("accounts.list");', async (page) => {
    await visit("/more", "Usage & accounts")(page);
    await page.getByText("Accounts unavailable").waitFor();
  }),
  "state-automations-loading": staged('daemon.holdRequests("automation.list");', async (page) => {
    await page.goto("/automations");
    await page.getByRole("status", { name: "Loading automations" }).waitFor();
  }),
  "state-automations-error": staged('daemon.failRequests("automation.list");', async (page) => {
    await page.goto("/automations");
    await page.getByRole("main").getByText("Automations unavailable").waitFor();
  }),
  "state-deck-loading": staged('daemon.holdRequests("conductor.request");', async (page) => {
    await page.goto("/deck");
    await page
      .getByRole("status", { name: /^Loading/ })
      .first()
      .waitFor();
  }),
  "state-deck-error": staged('daemon.failRequests("conductor.request");', async (page) => {
    await page.goto("/deck");
    await page.getByText("Decks unavailable").waitFor();
  }),
  "state-preview-download": staged("daemon.browser.requireDownload(180_000_000);", async (page) => {
    // The thread's first page downloads the browser: the Browser tab shows its progress.
    await rightTab("/t/thread-settings", /^Changes/)(page);
    const panel = page.getByRole("region", { name: "Thread panel" });
    await panel.getByRole("button", { name: "New tab" }).click();
    const address = panel.getByRole("combobox", { name: "Address" });
    await address.fill("localhost:5173");
    await address.press("Enter");
    await panel.getByRole("heading", { name: "Getting the browser ready" }).waitFor();
  }),
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
 * Narrow windows, the rail's tooltips, project folders, keyboard focus and reduced motion. At
 * 390px the rail and sidebar are a sheet opened from the header; below 1152px the panels float
 * over the transcript instead of squeezing it.
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
  // A rail icon's tooltip: its name and shortcut.
  "rail-tooltip": {
    width: 1440,
    height: 900,
    setup: async (page) => {
      await openThread("/t/thread-dedupe")(page);
      await page
        .getByRole("navigation", { name: "Views" })
        .getByRole("link", { name: "Deck" })
        .hover();
      await page.getByRole("tooltip").waitFor();
    },
  },
  // A project folder closed: its threads go, the folder says one of them needs you.
  "home-folder-closed": {
    width: 1440,
    height: 900,
    setup: async (page) => {
      await openThread("/t/thread-dedupe")(page);
      await threadList(page)
        .getByRole("button", { name: /^relay/ })
        .click();
      await expect(threadList(page).getByRole("link", { name: /^Retry budget/ })).toHaveCount(0);
    },
  },
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
      // From the first row (it needs you, so it offers no Settle) through its Snooze and Pin to
      // the second row.
      await threadList(page).getByRole("link").first().focus();
      for (let step = 0; step < 3; step++) await page.keyboard.press("Tab");
      await expect(threadList(page).getByRole("link").nth(1)).toBeFocused();
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
