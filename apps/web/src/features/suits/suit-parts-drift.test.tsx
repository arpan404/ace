import { suitParts } from "@ace/protocol/suit-parts";
import { coldStartReplay, facts, replayCursor, seedPanels, type Scenario } from "@ace/fake-daemon";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { FileChips } from "@/components/attachment-file-chips.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
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
function asks(id: string, title: string, request: Record<string, unknown>): Scenario {
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

const approvalScreen = ["approval-strip", "button"] as const;
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

const menuScreen = ["menu", "menu-item", "divider"] as const;

test("a thread row's menu names the menu and its items", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("answered");
  await app.open("/t/thread-replay-cursor");
  const list = await screen.findByRole("list", { name: "Threads" });
  fireEvent.contextMenu(within(list).getAllByRole("link")[0] as HTMLElement);
  await screen.findByRole("menu");
  await waitFor(() => expect(missing(menuScreen)).toEqual([]));
});

const settingsScreen = [
  "settings-nav",
  "nav-item",
  "settings-section",
  "settings-row",
  "switch",
  "select",
  "scrollbar",
] as const;

test("a settings page names its list, sections, rows and controls", async () => {
  const app = harness();
  await app.open("/settings/agents");
  await screen.findByRole("navigation", { name: "Settings pages" });
  await waitFor(() => expect(missing(settingsScreen)).toEqual([]));
});

const panelsScreen = ["terminal", "browser-panel", "command-palette"] as const;

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
  "checkbox",
  "turn-divider",
  "link",
  "attachment",
  "empty-state",
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
        <Checkbox aria-label="Always allow" checked />
        <CentredDivider icon={null}>Handed off to Claude</CentredDivider>
        <WebLink href="https://example.com">example.com</WebLink>
        <FileChips files={[{ key: "notes", name: "notes.md" }]} />
        <EmptyState title="Nothing here" />
      </ToastProvider>
    </TooltipProvider>,
  );
  // The open dialog hides the page from assistive tech, so the button is found by its words.
  fireEvent.click(screen.getByText("Copy"));
  await screen.findByRole("dialog", { name: "Rename" });
  await waitFor(() => expect(missing(sharedParts)).toEqual([]));
});

const coverage = [
  workingThread,
  settledThread,
  approvalScreen,
  questionScreen,
  menuScreen,
  settingsScreen,
  panelsScreen,
  sharedParts,
];

test("every part in the contract is drawn by a screen these tests walk", () => {
  const walked = new Set<string>(coverage.flat());
  expect(suitParts.filter((part) => !walked.has(part))).toEqual([]);
});
