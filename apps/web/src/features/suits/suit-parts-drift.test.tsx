import type { InteractionRequest } from "@ace/protocol";
import { suitParts } from "@ace/protocol/suit-parts";
import {
  chatScenario,
  coldStartReplay,
  facts,
  replayCursor,
  seedPanels,
  workbench,
  workbenchServices,
  type Scenario,
} from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { spadeApp, withEndpoint } from "@/test/spade.ts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { FileChips } from "@/components/attachment-file-chips.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { ProgressBar } from "@/components/ui/progress-bar.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Slider } from "@/components/ui/slider.tsx";
import { ToastProvider, useToast } from "@/components/ui/toast.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.tsx";
import { WebLink } from "@/components/web-link.tsx";
import { CentredDivider } from "@/features/thread/items/centred-divider.tsx";
import { harness } from "@/test/harness.tsx";
import { openWorkLog } from "@/test/open-work-log.ts";
import { terminalsOpenIn } from "@/test/terminal-place.ts";

/*
 * The Suit styling contract (ADR 0150, docs/design/suit-parts.md) is the list of parts the app
 * renders. Each test walks real screens and fails when one of its parts is no longer drawn; the
 * last one fails when a part is listed but no screen here shows it.
 */

beforeEach(() => localStorage.clear());

/** The parts this screen is missing from `parts`. */
function missing(parts: readonly string[]): string[] {
  const shown = new Set(
    [...document.querySelectorAll("[data-part]")].map((element) =>
      element.getAttribute("data-part"),
    ),
  );
  return parts.filter((part) => !shown.has(part));
}

const workingThread = [
  "app",
  "rail",
  "rail-item",
  "sidebar",
  "sidebar-header",
  "sidebar-footer",
  "sidebar-tabs",
  "thread-list",
  "thread-row",
  "thread-title",
  "thread-meta",
  "project-header",
  "header",
  "header-title",
  "main",
  "transcript",
  "message-user",
  "message-agent",
  "code-block",
  "inline-code",
  "working-line",
  "status-icon",
  "composer",
  "composer-input",
  "composer-toolbar",
  "composer-send",
  "model-picker",
  "icon-button",
  "tab",
] as const;

const settledThread = [
  "message-meta",
  "tool-row",
  "tool-output",
  "diff",
  "right-panel",
  "panel-header",
  "tabs",
  "file-tree",
  "tool-icon",
  "tool-group-header",
] as const;

test("a working thread names the window, the transcript and the composer", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("answered");
  await app.open("/t/thread-replay-cursor");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Server:");
  await waitFor(() => expect(missing(workingThread)).toEqual([]));

  act(() => app.daemon.apply("thread-replay-cursor", [facts.endTurn("root")]));
  const steps = await openWorkLog(feed);
  await userEvent.click(
    within(steps).getByRole("button", { name: /Ran bun run test apps\/server/ }),
  );
  await userEvent.click(
    within(steps).getByRole("button", { name: /Edited apps\/web\/src\/relay\/outbox.ts/ }),
  );
  const summary = await within(feed).findByRole("group", { name: /^Changed 2 files/ });
  const chip = within(summary).getAllByRole("button")[1];
  if (!chip) throw new Error("No changed-file chip");
  await userEvent.click(chip);
  await screen.findByRole("region", { name: "Thread panel" });
  await waitFor(() => expect(missing(settledThread)).toEqual([]));
});

/** A Codex thread whose agent waits on one request, approval or question. */
function asks(id: string, title: string, request: InteractionRequest): Scenario {
  return {
    thread: { id, workspaceId: "relay", title, provider: "codex" },
    steps: [
      {
        kind: "facts",
        facts: [
          {
            type: "agent.seen",
            agent: "root",
            origin: "root",
            fidelity: "full",
            native: { provider: "codex", nativeId: "root" },
            cwd: "/Users/dev/relay",
          },
          { type: "turn.started", agent: "root", nativeTurnId: "t1", trigger: "user" },
          {
            type: "interaction.opened",
            agent: "root",
            interaction: "ask",
            blocking: true,
            request,
          },
        ],
      },
      { kind: "await", interaction: "ask" },
    ],
  };
}

const approvalScreen = ["approval-strip", "button", "composer-strip"] as const;
const questionScreen = ["question-card", "input"] as const;

const pushApproval = asks("thread-push", "Push", {
  kind: "approval",
  title: "Allow git push to main?",
  options: [
    { id: "once", label: "Approve once", kind: "allow_once" },
    { id: "deny", label: "Decline", kind: "deny" },
  ],
});

const indentQuestion = asks("thread-indent", "Indentation", {
  kind: "question",
  questions: [
    {
      id: "style",
      header: "Indentation",
      text: "Tabs or Spaces?",
      multiSelect: false,
      allowOther: true,
      secret: false,
      options: [
        { id: "tabs", label: "Tabs" },
        { id: "spaces", label: "Spaces" },
      ],
    },
  ],
});

test("a waiting approval names its strip", async () => {
  const app = harness();
  app.play(pushApproval).runUntilBlocked();
  await app.open("/t/thread-push");
  await screen.findByRole("region", { name: "Waiting for you" });
  await waitFor(() => expect(missing(approvalScreen)).toEqual([]));
});

test("a waiting question names its card", async () => {
  const app = harness();
  app.play(indentQuestion).runUntilBlocked();
  await app.open("/t/thread-indent");
  await screen.findByRole("article", { name: "Tabs or Spaces?" });
  await waitFor(() => expect(missing(questionScreen)).toEqual([]));
});

const queueScreen = ["composer-strip", "queue-strip", "queue-item"] as const;

test("a queued message names the composer's strip, the queue and its row", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("answered");
  await app.open("/t/thread-replay-cursor");
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Then run the tests{Enter}",
  );
  await screen.findByRole("list", { name: "Queued messages" });
  await waitFor(() => expect(missing(queueScreen)).toEqual([]));
  const strip = document.querySelector('[data-part="composer-strip"]');
  expect(strip?.getAttribute("data-variant")).toBe("queue");
});

const menuScreen = ["menu", "menu-item", "divider"] as const;

test("a thread row's menu names the menu and its items", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("answered");
  await app.open("/t/thread-replay-cursor");
  const list = await screen.findByRole("list", { name: "Projects" });
  fireEvent.contextMenu(within(list).getAllByRole("link")[0] as HTMLElement);
  await screen.findByRole("menu");
  await waitFor(() => expect(missing(menuScreen)).toEqual([]));
});

const settingsScreen = [
  "settings-nav",
  "nav-item",
  "settings-section",
  "section-title",
  "settings-row",
  "switch",
  "switch-thumb",
  "select",
  "scrollbar",
] as const;

test("a settings page names its list, sections, rows and controls", async () => {
  const app = harness();
  await app.open("/settings/agents");
  await screen.findByRole("navigation", { name: "Settings pages" });
  await waitFor(() => expect(missing(settingsScreen)).toEqual([]));
});

const panelsScreen = [
  "terminal",
  "terminal-tab",
  "browser-panel",
  "command-palette",
  "search-field",
] as const;

test("the terminal, the browser and the command palette name their surfaces", async () => {
  const app = harness();
  terminalsOpenIn(app.storage, "side");
  app.play(coldStartReplay()).runThrough("turn-2");
  seedPanels(app.daemon);
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}`{/Control}");
  await waitFor(() => expect(missing(["terminal"])).toEqual([]));
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  await waitFor(() => expect(missing(["browser-panel"])).toEqual([]));
  await userEvent.keyboard("{Meta>}k{/Meta}");
  await waitFor(() => expect(missing(panelsScreen)).toEqual([]));
});

function ToastButton() {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.add({ title: "Copied" })}>
      Copy
    </button>
  );
}

const sharedParts = [
  "dialog",
  "popover",
  "tooltip",
  "toast",
  "badge",
  "kbd",
  "slider",
  "slider-thumb",
  "segmented",
  "segment",
  "segmented-thumb",
  "checkbox",
  "turn-divider",
  "link",
  "attachment",
  "empty-state",
  "progress",
] as const;

test("the shared overlays and controls name themselves wherever they are used", async () => {
  render(
    <TooltipProvider>
      <ToastProvider>
        <ToastButton />
        <Tooltip open>
          <TooltipTrigger render={<button type="button" />}>Hover</TooltipTrigger>
          <TooltipContent>A tip</TooltipContent>
        </Tooltip>
        <Popover open>
          <PopoverTrigger render={<button type="button" />}>Open</PopoverTrigger>
          <PopoverContent>Popover</PopoverContent>
        </Popover>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Rename</DialogTitle>
          </DialogContent>
        </Dialog>
        <Badge>3</Badge>
        <Kbd keys="mod+k" resolve={false} />
        <Slider label="Opacity" value={40} />
        <SegmentedControl
          label="Mode"
          value="light"
          onValueChange={() => {}}
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
        <Checkbox aria-label="Always allow" checked />
        <CentredDivider icon={null}>Handed off to Claude</CentredDivider>
        <WebLink href="https://example.com">example.com</WebLink>
        <FileChips files={[{ key: "notes", name: "notes.md" }]} />
        <EmptyState title="Nothing here" />
        <ProgressBar label="Receiving objects" value={52} />
      </ToastProvider>
    </TooltipProvider>,
  );
  // The open dialog hides the page from assistive tech, so the button is found by its words.
  fireEvent.click(screen.getByText("Copy"));
  await screen.findByRole("dialog", { name: "Rename" });
  await waitFor(() => expect(missing(sharedParts)).toEqual([]));
});

/** Every side panel tab names its strip tab, its body and its toolbar; Changes its files and lines. */
const panelTabs = [
  "panel-tab",
  "panel-body",
  "panel-toolbar",
  "list-row",
  "diff-file",
  "diff-line",
  "list",
  "card",
] as const;

test("the side panel's tabs name their tab, body, toolbar, rows, diffs and cards", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  seedPanels(app.daemon);
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  await within(panel).findByRole("list", { name: "Tools" });
  await waitFor(() => expect(missing(["panel-tab", "panel-body", "list", "card"])).toEqual([]));
  const changes = within(panel).getAllByRole("button", { name: /^Changes/ })[0];
  if (!changes) throw new Error("No Changes tool");
  // Changes takes the launcher's place.
  await userEvent.click(changes);
  const shown = panelTabs.filter((part) => part !== "list" && part !== "card");
  await waitFor(() => expect(missing(shown)).toEqual([]));
  // Each tab's body and strip tab carry its kind, so a Suit can style one tool apart.
  const bodies = [...panel.querySelectorAll('[data-part="panel-body"]')];
  expect(bodies.map((body) => body.getAttribute("data-variant"))).toContain("changes");
  const tabs = [...panel.querySelectorAll('[data-part="panel-tab"][data-state="selected"]')];
  expect(tabs.map((tab) => tab.getAttribute("data-variant"))).toEqual(["changes"]);
});

/** Drawn on the Code review pages, walked by features/forge-pages/forge-suit-parts.test.tsx. */
const codeReviewPages = [
  "page",
  "page-header",
  "page-title",
  "page-toolbar",
  "page-body",
  "page-section",
  "list",
  "list-row",
  "list-group",
  "card",
  "filter-bar",
  "search-field",
  "avatar",
  "label-chip",
  "pr-header",
  "pr-row",
  "issue-row",
  "review-comment",
  "review-thread",
  "check-row",
  "commit-row",
  "diff-file",
  "timeline-item",
  "branch-chip",
  "merge-box",
] as const;

const pagesScreen = [
  "page",
  "page-header",
  "page-title",
  "page-toolbar",
  "page-body",
  "page-section",
  "list",
  "list-group",
  "list-row",
  "card",
  "table",
  "table-row",
  "stat",
  "chart",
  "filter-bar",
  "label-chip",
  "chat-row",
] as const;

test("full pages name their header, body, lists, rows, cards and figures", async () => {
  const history = createMemoryHistory({ initialEntries: ["/usage"] });
  const app = harness({ clock: () => Date.now(), history });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now(), "UTC"));
  const chat = chatScenario("trip", "Three days in Lisbon", "claude", "Plan it.", "Alfama first.");
  app.play(chat).runUntilBlocked();
  app.daemon.services.usage.sources = [
    {
      provider: "codex",
      account: "codex-personal",
      model: "gpt-5.3-codex",
      daily: 80_000,
      steady: true,
      apiUsdPerMillion: 5,
      billing: "subscription",
      threads: ["thread-codex"],
    },
  ];
  await app.open("/usage");
  // Each page draws some of the parts; together they draw them all.
  const seen = new Set<string>();
  const look = () => {
    for (const element of document.querySelectorAll("[data-part]"))
      seen.add(element.getAttribute("data-part") ?? "");
  };
  const visit = async (path: string, ready: () => Promise<unknown>) => {
    act(() => history.push(path));
    await ready();
    look();
  };
  await screen.findByRole("list", { name: /^Spend by / });
  await userEvent.click(screen.getByRole("button", { name: "Token types" }));
  await screen.findByRole("table", { name: "Tokens and cost by type" });
  look();
  await visit("/history", () => screen.findAllByRole("heading", { name: "History" }));
  await visit(`/t/${chat.thread.id}`, () =>
    waitFor(() => expect(document.querySelector('[data-part="chat-row"]')).not.toBeNull()),
  );
  await visit("/automations/auto-dependency-audit", () =>
    screen.findAllByText("Nightly dependency audit"),
  );
  await waitFor(() => {
    look();
    expect(pagesScreen.filter((part) => !seen.has(part))).toEqual([]);
  });
});

const spadeScreen = ["spade-message", "avatar"] as const;

test("Spade's conversation names its messages and faces", async () => {
  await spadeApp("/spade/garden", (spade) => {
    withEndpoint(spade);
    spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const garden = spade.addAgent({ id: "garden", name: "Garden" });
    spade.store(garden.conversation, { type: "user_message", text: "When do I plant garlic?" });
    spade.reply(garden, "In October.");
  });
  await screen.findByText("In October.");
  await waitFor(() => expect(missing(spadeScreen)).toEqual([]));
});

const marketScreen = [
  "nav-item",
  "section-title",
  "search-field",
  "market-hero",
  "market-stage",
  "market-try",
] as const;

test("the Marketplace page names its places, titles, featured pair, stages and Try it's bar", async () => {
  const history = createMemoryHistory({ initialEntries: ["/chats?market=discover"] });
  const app = harness({ history });
  app.daemon.seedServices({
    marketplace: {
      entries: [
        {
          summary: {
            source: "market",
            type: "suit",
            name: "harbour-dusk",
            title: "Harbour dusk",
            line: "Navy water and a warm lamp.",
            categories: [],
            keywords: [],
            version: "1.0.0",
            reviewed: true,
            byAce: false,
            updated: 1,
            downloads: 3,
            supported: true,
          },
        },
        {
          summary: {
            source: "market",
            type: "skill",
            name: "weekly-review",
            title: "Weekly review",
            line: "Sums up the week's threads.",
            categories: [],
            keywords: [],
            version: "1.0.0",
            reviewed: true,
            byAce: false,
            updated: 2,
            downloads: 1,
            supported: true,
          },
        },
      ],
      featured: [{ type: "suit", name: "harbour-dusk" }],
    },
  });
  await app.open("/chats?market=discover");
  await screen.findByRole("region", { name: "Marketplace" });
  await waitFor(() => expect(missing(marketScreen)).toEqual([]));
});

const coverage = [
  marketScreen,
  codeReviewPages,
  workingThread,
  settledThread,
  approvalScreen,
  questionScreen,
  queueScreen,
  menuScreen,
  settingsScreen,
  panelsScreen,
  panelTabs,
  sharedParts,
  pagesScreen,
  spadeScreen,
];

test("every part in the contract is drawn by a screen these tests walk", () => {
  const walked = new Set<string>(coverage.flat());
  expect(suitParts.filter((part) => !walked.has(part))).toEqual([]);
});
