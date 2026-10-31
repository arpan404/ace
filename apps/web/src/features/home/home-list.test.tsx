import { facts, workbench, type Scenario } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const titles = [...workbench().map((scenario) => scenario.thread.title), "Write the release notes"];
/** Thread titles in the order the Home list shows them. */
const order = () =>
  within(threads())
    .queryAllByRole("link")
    .map((link) => titles.find((title) => link.textContent?.includes(title)));
const card = (title: string | RegExp) => within(threads()).getByRole("link", { name: title });

async function rowAction(action: string, title: string) {
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${title}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: action }));
}
/** The titles of the rows marked as the open thread. */
const current = () =>
  within(threads())
    .getAllByRole("link", { current: "page" })
    .map((link) => titles.find((title) => link.textContent?.includes(title)));

/** A heading or place of the tree, by its accessible name. */
const head = (name: string | RegExp) => within(threads()).getByRole("button", { name });
/** Every keyboard stop of the list as it reads: rows by title, projects as [name], headings as heard. */
const stops = () =>
  [...threads().querySelectorAll<HTMLElement>("[data-row-focus], [data-section-toggle]")].map(
    (stop) =>
      stop.dataset.project !== undefined
        ? `[${stop.dataset.project}]`
        : (stop.getAttribute("aria-label")?.split(".")[0] ?? heard(stop)),
  );
/** An element's text as assistive tech hears it: without what it hides. */
function heard(element: HTMLElement): string {
  const copy = element.cloneNode(true);
  if (!(copy instanceof HTMLElement)) return "";
  for (const hidden of copy.querySelectorAll("[aria-hidden]")) hidden.remove();
  return copy.textContent ?? "";
}

/** `a` shows above `b` in the list. */
const before = (a: string, b: string) => order().indexOf(a) < order().indexOf(b);

/** Open the app and wait for the list to arrive. */
async function openHome(app: ReturnType<typeof harness>, path = "/") {
  const view = await app.open(path);
  const nav = await screen.findByRole("navigation", { name: "Threads" });
  // The list has arrived once its first stop (a row, or a heading) is drawn.
  await waitFor(() =>
    expect(nav.querySelector("[data-row-focus], [data-section-toggle]")).not.toBeNull(),
  );
  return view;
}

function workbenchApp(options: Parameters<typeof harness>[0] = {}) {
  const app = harness(options);
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  return app;
}

/** The Inbox button in the panel's title row. */
const bell = () => screen.getByRole("button", { name: /^Inbox/ });
/** Open the Inbox overlay and return it. */
async function openInbox() {
  await userEvent.click(bell());
  return screen.findByRole("dialog", { name: "Inbox" });
}
const inboxTitles = (dialog: HTMLElement) =>
  within(dialog)
    .queryAllByRole("link")
    .map((link) =>
      link
        .getAttribute("aria-label")
        ?.split(".")[0]
        ?.replace(/, unread$/, ""),
    );

/** A thread in relay whose one turn finished. */
const finished = (id: string, title: string): Scenario => ({
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
          type: "item.upsert",
          agent: "root",
          item: "ask",
          draft: {
            type: "message",
            role: "user",
            complete: true,
            parts: [{ type: "text", text: "Go." }],
          },
        },
        {
          type: "item.upsert",
          agent: "root",
          item: "reply",
          draft: {
            type: "message",
            role: "assistant",
            complete: true,
            parts: [{ type: "text", text: "Done." }],
          },
        },
        { type: "turn.ended", agent: "root", nativeTurnId: "t1", outcome: "completed" },
      ],
    },
  ],
});

/**
 * An approval and a finished thread, on a daemon whose clock runs ahead of this device's first
 * launch, so the finished turn is news here: Done until it is opened.
 */
function inboxApp() {
  let at = Date.now() + 60_000;
  const app = harness({ clock: () => (at = Math.max(at + 1, Date.now() + 60_000)) });
  const approval = workbench().find((each) => each.thread.id === "thread-retry-budget");
  if (approval) app.play(approval).runUntilBlocked();
  app.play(finished("thread-notes", "Write the release notes")).runUntilBlocked();
  return app;
}

test("the panel lists projects only, and what needs you waits in the Inbox, never in its project", async () => {
  await openHome(workbenchApp());
  expect(stops()).toEqual([
    "Add project",
    "[ace]",
    "Dedupe thread events after reconnect",
    "[relay]",
    "Backpressure on broadcast fan-out",
    "[billing-api]",
    "Invoice PDF locale fallback",
    "[ace-mobile]",
    "[docs-site]",
    "Rewrite the install page for the daemon",
  ]);
  // A waiting approval shows only in the Inbox.
  expect(order()).not.toContain("Retry budget for app-server restarts");
  expect(order()).not.toContain("Partial refunds double-count tax");
  // Long settled, the Codex bump is only in History.
  expect(order()).not.toContain("Bump Codex app-server to 0.48");
  expect(within(threads()).queryByRole("button", { name: /settled/ })).toBeNull();
});

test("the bell's count matches the Inbox, which lists an approval and finished work not yet opened", async () => {
  await openHome(inboxApp(), "/new");
  await waitFor(() => expect(bell().getAttribute("aria-label")).toBe("Inbox, 2 waiting"));
  const dialog = await openInbox();
  // Newest first.
  expect(inboxTitles(dialog)).toEqual([
    "Write the release notes",
    "Retry budget for app-server restarts",
  ]);
  expect(
    within(dialog).getByRole("link", { name: /^Retry budget.*Waiting for your approval/ }),
  ).toBeTruthy();
  // Unseen, the finished thread is heard as unread.
  expect(
    within(dialog).getByRole("link", { name: /^Write the release notes, unread/ }),
  ).toBeTruthy();
  // Rows only open their thread: nothing to approve, answer, snooze or mark read from here.
  expect(
    within(dialog).queryAllByRole("button", { name: /approve|answer|mark|snooze|settle|actions/i }),
  ).toEqual([]);
  // Neither shows in its project.
  expect(order()).toEqual([]);
});

test("opening finished work from the Inbox closes it and clears the thread from it", async () => {
  await openHome(inboxApp(), "/new");
  const dialog = await openInbox();
  await userEvent.click(within(dialog).getByRole("link", { name: /^Write the release notes/ }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Inbox" })).toBeNull());
  // Seen, it rests in its project, and the Inbox no longer holds it.
  await waitFor(() => expect(order()).toContain("Write the release notes"));
  await waitFor(() => expect(bell().getAttribute("aria-label")).toBe("Inbox, 1 waiting"));
  expect(inboxTitles(await openInbox())).toEqual(["Retry budget for app-server restarts"]);
});

test("Escape and the close button close the Inbox and give focus back to the bell; arrows move in it", async () => {
  await openHome(workbenchApp());
  let dialog = await openInbox();
  const rows = within(dialog).getAllByRole("link");
  await waitFor(() => expect(document.activeElement).toBe(rows[0]));
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(rows[1]);
  await userEvent.keyboard("{End}");
  expect(document.activeElement).toBe(rows.at(-1));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Inbox" })).toBeNull());
  expect(document.activeElement).toBe(bell());

  dialog = await openInbox();
  await userEvent.click(within(dialog).getByRole("button", { name: "Close Inbox" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Inbox" })).toBeNull());
  expect(document.activeElement).toBe(bell());
});

test("⌘I opens the Inbox from anywhere, and an empty one says so", async () => {
  const app = harness();
  app.daemon.createThread({ id: "t-1", workspaceId: "ace", title: "Tidy up", provider: "codex" });
  app.daemon.apply("t-1", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "sent", "user", "Tidy"),
    facts.endTurn("root"),
  ]);
  await app.open("/settings/agents");
  await screen.findByRole("heading", { name: "Agents" });
  await userEvent.keyboard("{Meta>}i{/Meta}");
  const dialog = await screen.findByRole("dialog", { name: "Inbox" });
  expect(within(dialog).getByText("You’re all caught up.")).toBeTruthy();
});

test("a folded project keeps its heading and Inbox count, hides its threads, across a reload", async () => {
  const storage = memoryKeyValue();
  const view = await openHome(workbenchApp({ storage }));
  const relay = within(threads()).getByRole("button", { name: /^relay/ });
  await userEvent.click(relay);
  expect(relay.getAttribute("aria-expanded")).toBe("false");
  await waitFor(() => expect(order()).not.toContain("Backpressure on broadcast fan-out"));
  // It says how many of its threads wait in the Inbox.
  expect(head(/^relay.*, 1 in the Inbox/)).toBeTruthy();
  view.unmount();

  await openHome(workbenchApp({ storage }));
  expect(head(/^relay/).getAttribute("aria-expanded")).toBe("false");
  expect(order()).not.toContain("Backpressure on broadcast fan-out");
  await userEvent.click(head(/^relay/));
  expect(await within(threads()).findByRole("link", { name: /^Backpressure/ })).toBeTruthy();
});

test("projects with nothing open fold under Quiet projects, each opening its History", async () => {
  const app = workbenchApp();
  app.daemon.createThread({
    id: "thread-notes",
    workspaceId: "notes",
    title: "Write release notes",
    provider: "codex",
  });
  app.daemon.apply("thread-notes", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "sent", "user", "Write the notes"),
    facts.endTurn("root"),
  ]);
  await openHome(app);
  await app.client.command({ type: "thread.settle", threadId: ThreadId.parse("thread-notes") });
  const quiet = await within(threads()).findByRole("button", { name: /^Quiet projects/ });
  expect(quiet.getAttribute("aria-expanded")).toBe("false");
  await waitFor(() => expect(stops()).not.toContain("[notes]"));
  await userEvent.click(quiet);
  await userEvent.click(await within(threads()).findByRole("link", { name: "notes, History" }));
  expect(await screen.findByRole("heading", { level: 2, name: "History" })).toBeTruthy();
  const main = screen.getByRole("main");
  expect(await within(main).findByRole("link", { name: /^Write release notes/ })).toBeTruthy();
  expect(within(main).getByRole("button", { name: "notes" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

test("a pinned thread leads its project, ahead of running work", async () => {
  const app = workbenchApp(soon);
  await openHome(app);
  await unsettleBump();
  await app.client.command({
    type: "thread.pin",
    threadId: ThreadId.parse("thread-bump-codex"),
    pinned: true,
  });
  await waitFor(() =>
    expect(before("Bump Codex app-server to 0.48", "Dedupe thread events after reconnect")).toBe(
      true,
    ),
  );
  expect(card(/^Bump Codex app-server to 0.48\..*Pinned/)).toBeTruthy();
});

test("tasks expose status, linked PR, provider and branch details", async () => {
  await openHome(workbenchApp());
  const inbox = await openInbox();
  const refund = within(inbox).getByRole("link", { name: /^Partial refunds double-count tax/ });
  // The branch is drawn whole, its middle the part that gives way when it doesn't fit.
  expect(within(refund).getByTitle("fix/refund-tax").textContent).toBe("fix/refund-tax");
  expect(refund.getAttribute("aria-label") ?? refund.textContent).toContain(
    "Waiting for your approval",
  );
  // The accessible name retains the PR, branch and project.
  expect(refund.getAttribute("aria-label")).toContain("Pull request #77");
  expect(refund.getAttribute("aria-label")).toContain("fix/refund-tax");
  expect(refund.getAttribute("aria-label")).toContain("billing-api");
  expect(within(refund).getByText("billing-api")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(within(threads()).queryAllByRole("heading")).toHaveLength(0);

  // Rows waiting on their subagents expose their worktree and subagents too.
  const dedupe = card(/^Dedupe thread events after reconnect/);
  expect(within(dedupe).getByTitle("fix/replay-dedupe").textContent).toBe("fix/replay-dedupe");
  expect(dedupe.getAttribute("aria-label")).toContain("Claude Code · 2 subagents running");
  expect(dedupe.getAttribute("aria-label") ?? dedupe.textContent).toMatch(
    /\. Waiting for 2 subagents, /,
  );
  // The branch stays available while diff totals stay out of the sidebar.
  const install = card(/^Rewrite the install page for the daemon/);
  expect(install.getAttribute("aria-label")).toContain("OpenCode");
  expect(install.getAttribute("aria-label")).toContain("docs/install-daemon");
  expect(within(install).queryByText("+120")).toBeNull();
  expect(install.getAttribute("aria-label")).not.toMatch(/lines added|removed/);
});

/** Bring the recently settled thread back into its project, done and at rest. */
async function unsettleBump() {
  await within(threads()).findByRole("link", { name: /^Bump Codex.*Settled/ });
  await rowAction("Unsettle", "Bump Codex app-server to 0.48");
  await waitFor(() =>
    expect(within(threads()).queryByRole("link", { name: /^Bump Codex.*Settled/ })).toBeNull(),
  );
  await within(threads()).findByRole("link", { name: /^Bump Codex/ });
}

/** The UI's clock just past the daemon's: the workbench's settled thread settled moments ago. */
const soon = { uiClock: () => 600_000 };

test("finished work follows running work in its project", async () => {
  await openHome(workbenchApp(soon));
  await unsettleBump();
  expect(before("Dedupe thread events after reconnect", "Bump Codex app-server to 0.48")).toBe(
    true,
  );
  expect(before("Bump Codex app-server to 0.48", "Backpressure on broadcast fan-out")).toBe(true);
});

test("Up and Down (and j and k) move between rows and headings", async () => {
  await openHome(workbenchApp());
  const ace = head(/^ace, 1 running/);
  const dedupe = card(/^Dedupe thread events/);
  ace.focus();
  await userEvent.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(head("Add project"));
  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(ace);
  // → reaches a project's own actions, ← comes back.
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "New thread in ace" }));
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "History of ace" }));
  await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
  expect(document.activeElement).toBe(ace);
  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(dedupe);
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(head(/^relay/));
  await userEvent.keyboard("k");
  expect(document.activeElement).toBe(dedupe);
});

test("a row's name says its status, provider and subagents, branch, pull request, project and machine", async () => {
  await openHome(workbenchApp());
  expect(
    within(await openInbox()).getByRole("link", {
      name: /^Partial refunds double-count tax\. Waiting for your approval, Claude Code, .*Pull request #77/,
    }),
  ).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(
    card(
      /^Dedupe thread events after reconnect\. Waiting for 2 subagents, Claude Code · 2 subagents running, Worktree fix\/replay-dedupe/,
    ),
  ).toBeTruthy();
  expect(card(/^Backpressure on broadcast fan-out\..*Running on build-box/)).toBeTruthy();
  expect(
    card(
      /^Rewrite the install page for the daemon\..*Branch docs\/install-daemon, Project docs-site/,
    ),
  ).toBeTruthy();
});

test("a row's actions offer Settle for finished work and hide it while work continues", async () => {
  await openHome(workbenchApp(soon));
  await unsettleBump();
  await userEvent.click(
    screen.getByRole("button", { name: "Actions for Bump Codex app-server to 0.48" }),
  );
  expect(await screen.findByRole("menuitem", { name: "Settle" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(
    screen.getByRole("button", { name: "Actions for Dedupe thread events after reconnect" }),
  );
  expect(screen.queryByRole("menuitem", { name: "Settle" })).toBeNull();
});

test("the open thread's row is the current one, and moves with the thread opened", async () => {
  await openHome(workbenchApp(), "/t/thread-fan-out");
  await waitFor(() => expect(current()).toEqual(["Backpressure on broadcast fan-out"]));
  await userEvent.click(card(/^Invoice PDF locale fallback/));
  await waitFor(() => expect(current()).toEqual(["Invoice PDF locale fallback"]));
});

test("hovering a row's link shows what its marks mean in a tooltip", async () => {
  await openHome(workbenchApp());
  await userEvent.hover(await within(threads()).findByRole("link", { name: /^Invoice PDF/ }));
  const tip = await screen.findByLabelText(/^Details for /);
  expect(tip.textContent).toContain("billing-api");
  const prs = within(tip).getByRole("list", {
    name: "Pull requests in github.com/acme/billing-api",
  });
  expect(within(prs).getByRole("listitem", { name: /^#74, open\b/ })).toBeTruthy();
});

test("Settle dims a finished thread in its project and Unsettle puts it back", async () => {
  const app = workbenchApp(soon);
  const settledAt = () => {
    const view = app.daemon.snapshot({ kind: "threads" });
    return view?.kind === "threads" ? view.threads["thread-bump-codex"]?.settledAt : undefined;
  };
  await openHome(app);
  await unsettleBump();
  await waitFor(() => expect(settledAt()).toBeUndefined());

  await rowAction("Settle", "Bump Codex app-server to 0.48");
  expect(await within(threads()).findByRole("link", { name: /^Bump Codex.*Settled/ })).toBeTruthy();
  await waitFor(() => expect(settledAt()).toBeDefined());
});

test("a thread long in History comes back to its project as soon as it moves again, as running", async () => {
  const app = workbenchApp();
  await openHome(app);
  expect(order()).not.toContain("Bump Codex app-server to 0.48");

  // New work on it: the agent starts another turn and the thread is working again.
  app.daemon.apply("thread-bump-codex", [
    { type: "turn.started", agent: "root", nativeTurnId: "follow-up", trigger: "user" },
  ]);
  await waitFor(() => expect(head(/^ace, 2 running/)).toBeTruthy());
  // Under its project, never in the Inbox, never dimmed and never as Done: its tree is working.
  expect(card(/^Bump Codex app-server to 0\.48\. Working/)).toBeTruthy();
  expect(before("Bump Codex app-server to 0.48", "Backpressure on broadcast fan-out")).toBe(true);
});

test("a snoozed request stays in the Inbox with its wake time", async () => {
  const app = workbenchApp();
  await openHome(app);
  await app.client.command({
    type: "thread.snooze",
    threadId: ThreadId.parse("thread-retry-budget"),
    until: Date.now() + 24 * 60 * 60 * 1000,
  });
  // A thread waiting on the person is never folded away: it stays in the Inbox, marked snoozed.
  const dialog = await openInbox();
  await waitFor(() =>
    expect(within(dialog).getByRole("link", { name: /^Retry budget.*Snoozed until/ })).toBeTruthy(),
  );
  expect(within(threads()).queryByRole("button", { name: /^Snoozed / })).toBeNull();
});

test("the project filter narrows Home to one project and is remembered", async () => {
  const storage = memoryKeyValue();
  const view = await openHome(workbenchApp({ storage }));
  await userEvent.click(screen.getByRole("button", { name: "Project filter: All projects" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "relay" }));

  await waitFor(() => expect(order()).toEqual(["Backpressure on broadcast fan-out"]));
  // The Inbox follows the filter too.
  expect(inboxTitles(await openInbox())).toEqual(["Retry budget for app-server restarts"]);
  await userEvent.keyboard("{Escape}");
  view.unmount();

  await openHome(workbenchApp({ storage }));
  expect(await screen.findByRole("button", { name: "Project filter: relay" })).toBeTruthy();
  await waitFor(() => expect(order()).toEqual(["Backpressure on broadcast fan-out"]));
});

test("a row's name and tooltip give its whole branch, including main", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "thread-on-main",
    workspaceId: "relay",
    title: "Tidy the README",
    provider: "codex",
    details: { branch: "main", mode: "local" },
  });
  app.daemon.createThread({
    id: "thread-hash-branch",
    workspaceId: "relay",
    title: "Support spare-part materials",
    provider: "codex",
    details: { branch: "ace/33594883e2b3ea4fc70aeea5", mode: "worktree" },
  });
  for (const id of ["thread-on-main", "thread-hash-branch"])
    app.daemon.apply(id, [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.message("root", "sent", "user", "Tidy this project"),
      facts.endTurn("root"),
    ]);
  await openHome(app);

  const hashed = card(/^Support spare-part materials/);
  expect(hashed.getAttribute("aria-label") ?? hashed.textContent).toContain(
    "Worktree ace/33594883e2b3ea4fc70aeea5",
  );
  await userEvent.hover(hashed);
  expect((await screen.findByLabelText(/^Details for /)).textContent).toContain(
    "ace/33594883e2b3ea4fc70aeea5",
  );

  const onMain = card(/^Tidy the README/);
  expect(onMain.getAttribute("aria-label")).toContain("Branch main");
  expect(within(onMain).getByTitle("main").textContent).toBe("main");
  await userEvent.unhover(hashed);
  onMain.focus();
  const details = await screen.findByLabelText(/^Details for Tidy the README/);
  expect(within(details).getByText("main", { exact: true })).toBeTruthy();
});
