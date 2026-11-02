import { facts, workbench, type Scenario } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { ThreadId } from "@ace/protocol";
import type { Fact } from "@ace/core";
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

/** Every keyboard stop of the list as it reads: rows by title, anything else as heard. */
const stops = () =>
  [...threads().querySelectorAll<HTMLElement>("[data-row-focus], [data-section-toggle]")].map(
    (stop) =>
      stop
        .getAttribute("aria-label")
        ?.split(". ")[0]
        ?.replace(/, unread$/, "") ?? heard(stop),
  );
/** An element's text as assistive tech hears it: without what it hides. */
function heard(element: HTMLElement): string {
  const copy = element.cloneNode(true);
  if (!(copy instanceof HTMLElement)) return "";
  for (const hidden of copy.querySelectorAll("[aria-hidden]")) hidden.remove();
  return copy.textContent ?? "";
}
/** One of the panel's tabs: Inbox, Snoozed or Settled. */
const tab = (name: string) =>
  within(threads()).getByRole("tab", { name: new RegExp(`^${name}\\b`) });
/** Open a tab and wait until it is the one shown. */
async function openTab(name: string) {
  await userEvent.click(tab(name));
  await waitFor(() => expect(tab(name).getAttribute("aria-selected")).toBe("true"));
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

/** A thread in billing-api whose turn started on a message, then went on with `then`. */
const inBilling = (id: string, title: string, then: Fact[]): Scenario => ({
  thread: { id, workspaceId: "billing-api", title, provider: "codex" },
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
          cwd: "/Users/dev/billing-api",
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
        ...then,
      ],
    },
  ],
});

/**
 * An approval and a finished thread, on a daemon whose clock runs ahead of this device's first
 * launch, so the finished turn is news here: Done until it is opened.
 */
function newsApp() {
  let at = Date.now() + 60_000;
  const app = harness({ clock: () => (at = Math.max(at + 1, Date.now() + 60_000)) });
  const approval = workbench().find((each) => each.thread.id === "thread-retry-budget");
  if (approval) app.play(approval).runUntilBlocked();
  app.play(finished("thread-notes", "Write the release notes")).runUntilBlocked();
  return app;
}

test("an approval leads the Inbox, which spans projects; a long-settled thread rests in Settled", async () => {
  await openHome(workbenchApp());
  const top = stops();
  // What needs the person comes first, whatever its project.
  expect(top.slice(0, 3).toSorted()).toEqual([
    "Approval sheet loses its state on rotate",
    "Partial refunds double-count tax",
    "Retry budget for app-server restarts",
  ]);
  expect(top).toContain("Backpressure on broadcast fan-out");
  expect(top).toContain("Dedupe thread events after reconnect");
  // Each row names its project in words, with no mark.
  const refund = card(/^Partial refunds double-count tax/);
  expect(refund.querySelector("[data-project-mark]")).toBeNull();
  expect(refund.getAttribute("aria-label")).toContain("Project billing-api");
  // Long settled, the Codex bump rests in Settled, never in the Inbox.
  expect(top).not.toContain("Bump Codex app-server to 0.48");
  await openTab("Settled");
  await waitFor(() => expect(stops()).toEqual(["Bump Codex app-server to 0.48"]));
});

test("in the Inbox an approval, a failure, a working thread, unseen finished work and an idle thread show in that order across projects, with no headings", async () => {
  // Work from before this device's first launch counts as seen; later work is news here.
  let ahead = false;
  let at = Date.now() - 600_000;
  const app = harness({
    clock: () => (at = ahead ? Math.max(at + 1, Date.now() + 60_000) : at + 1),
  });
  // Played in the reverse of the order they show, so the list's order is its own.
  app.play(finished("thread-idle", "Tidy the changelog")).runUntilBlocked();
  ahead = true;
  app.play(finished("thread-notes", "Write the release notes")).runUntilBlocked();
  app.play(inBilling("thread-working", "Round invoice totals", [])).runUntilBlocked();
  app
    .play(
      inBilling("thread-failing", "Fix the flaky tax test", [
        { type: "turn.ended", agent: "root", nativeTurnId: "t1", outcome: "failed" },
      ]),
    )
    .runUntilBlocked();
  // Asking last, the approval is also the newest: it leads the failure within "needs you".
  app
    .play(
      inBilling("thread-asks", "Publish the release", [
        {
          type: "interaction.opened",
          agent: "root",
          interaction: "publish",
          blocking: true,
          request: {
            kind: "approval",
            title: "Publish?",
            options: [{ id: "allow", label: "Approve", kind: "allow_once" }],
          },
        },
      ]),
    )
    .runUntilBlocked();

  await openHome(app, "/new");
  await waitFor(() =>
    expect(stops()).toEqual([
      "Publish the release",
      "Fix the flaky tax test",
      "Round invoice totals",
      "Write the release notes",
      "Tidy the changelog",
    ]),
  );
  // One flat list: no Active, Projects or project headings between the rows, and each row
  // names its own project.
  const list = screen.getByRole("list", { name: "Threads" });
  expect(within(list).queryAllByRole("heading")).toEqual([]);
  expect(list.querySelector("[data-section-toggle]")).toBeNull();
  expect(within(list).queryAllByText(/^(Active|Projects)$/)).toEqual([]);
  expect(card(/^Round invoice totals/).getAttribute("aria-label")).toContain("Project billing-api");
  expect(card(/^Tidy the changelog/).getAttribute("aria-label")).toContain("Project relay");
});

test("finished work not yet opened stays in the Inbox with the blue dot", async () => {
  await openHome(newsApp(), "/new");
  await waitFor(() => expect(stops()).toContain("Write the release notes"));
  const notes = card(/^Write the release notes, unread/);
  expect(notes.querySelector('[data-tone="unread"], [data-tone="done"]')).not.toBeNull();
  await openTab("Settled");
  expect(stops()).not.toContain("Write the release notes");
});

test("there is no notification bell, and ⌘I opens nothing", async () => {
  await openHome(newsApp(), "/new");
  expect(screen.queryByRole("button", { name: /^Inbox/ })).toBeNull();
  await userEvent.keyboard("{Meta>}i{/Meta}");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("settling a thread moves it from the Inbox to Settled", async () => {
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
  await waitFor(() => expect(stops()).toContain("Write release notes"));
  await app.client.command({ type: "thread.settle", threadId: ThreadId.parse("thread-notes") });
  await waitFor(() => expect(stops()).not.toContain("Write release notes"));
  await openTab("Settled");
  // Settled is newest first: the thread settled just now leads it.
  await waitFor(() =>
    expect(stops()).toEqual(["Write release notes", "Bump Codex app-server to 0.48"]),
  );
});

test("a pinned thread leads the Inbox, ahead of what needs you", async () => {
  const app = workbenchApp(soon);
  await openHome(app);
  await unsettleBump();
  await app.client.command({
    type: "thread.pin",
    threadId: ThreadId.parse("thread-bump-codex"),
    pinned: true,
  });
  await waitFor(() => expect(stops()[0]).toBe("Bump Codex app-server to 0.48"));
  expect(card(/^Bump Codex app-server to 0.48\..*Pinned/)).toBeTruthy();
});

test("tasks expose status, linked PR, provider and branch details", async () => {
  await openHome(workbenchApp());
  const refund = card(/^Partial refunds double-count tax/);
  expect(refund.getAttribute("aria-label")).toContain("Waiting for your approval");
  // The accessible name retains the PR, branch and project.
  expect(refund.getAttribute("aria-label")).toContain("Pull request #77");
  expect(refund.getAttribute("aria-label")).toContain("fix/refund-tax");
  expect(refund.getAttribute("aria-label")).toContain("billing-api");

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

/** Bring the recently settled thread back from Settled into the Inbox, done and at rest. */
async function unsettleBump() {
  await openTab("Settled");
  await within(threads()).findByRole("link", { name: /^Bump Codex/ });
  await rowAction("Unsettle", "Bump Codex app-server to 0.48");
  await waitFor(() =>
    expect(within(threads()).queryByRole("link", { name: /^Bump Codex/ })).toBeNull(),
  );
  await openTab("Inbox");
  await within(threads()).findByRole("link", { name: /^Bump Codex/ });
}

/** The UI's clock just past the daemon's: the workbench's settled thread settled moments ago. */
const soon = { uiClock: () => 600_000 };

test("in the Inbox, finished work follows running and waiting work", async () => {
  await openHome(workbenchApp(soon));
  await unsettleBump();
  await waitFor(() => expect(stops()).toContain("Bump Codex app-server to 0.48"));
  expect(before("Dedupe thread events after reconnect", "Bump Codex app-server to 0.48")).toBe(
    true,
  );
  expect(before("Backpressure on broadcast fan-out", "Bump Codex app-server to 0.48")).toBe(true);
});

test("Up and Down (and j and k) move between the Inbox's rows, across projects", async () => {
  await openHome(workbenchApp());
  const rows = within(threads())
    .getAllByRole("link")
    .filter((link) => link.hasAttribute("data-row-focus"));
  const [first, second, third] = rows;
  if (!first || !second || !third) throw new Error("The Inbox needs three rows");
  first.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(second);
  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(third);
  await userEvent.keyboard("k");
  expect(document.activeElement).toBe(second);
  await userEvent.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(first);
  // → reaches a row's own actions, ← comes back.
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Snooze /);
  await userEvent.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(first);
});

test("a row's name says its status, provider and subagents, branch, pull request, project and machine", async () => {
  await openHome(workbenchApp());
  expect(
    card(
      /^Partial refunds double-count tax\. Needs approval, Waiting for your approval, Claude Code, .*Pull request #77/,
    ),
  ).toBeTruthy();
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

test("Settle moves a finished thread to Settled in muted ink, and Unsettle puts it back", async () => {
  const app = workbenchApp(soon);
  const settledAt = () => {
    const view = app.daemon.snapshot({ kind: "threads" });
    return view?.kind === "threads" ? view.threads["thread-bump-codex"]?.settledAt : undefined;
  };
  await openHome(app);
  await unsettleBump();
  await waitFor(() => expect(settledAt()).toBeUndefined());

  await rowAction("Settle", "Bump Codex app-server to 0.48");
  await waitFor(() => expect(stops()).not.toContain("Bump Codex app-server to 0.48"));
  await waitFor(() => expect(settledAt()).toBeDefined());
  await openTab("Settled");
  const bump = await within(threads()).findByRole("link", { name: /^Bump Codex/ });
  expect(bump.closest("[data-muted]")).not.toBeNull();
});

test("a settled thread that moves again leaves Settled for the Inbox, as running", async () => {
  const app = workbenchApp();
  await openHome(app);
  expect(stops()).not.toContain("Bump Codex app-server to 0.48");

  // New work on it: the agent starts another turn and the thread is working again.
  app.daemon.apply("thread-bump-codex", [
    { type: "turn.started", agent: "root", nativeTurnId: "follow-up", trigger: "user" },
  ]);
  await waitFor(() => expect(stops()).toContain("Bump Codex app-server to 0.48"));
  // A running tree is never in Settled, never dimmed and never Done.
  expect(card(/^Bump Codex app-server to 0\.48\. Working/)).toBeTruthy();
  await openTab("Settled");
  await waitFor(() => expect(stops()).not.toContain("Bump Codex app-server to 0.48"));
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
  await waitFor(() => expect(card(/^Retry budget.*Snoozed until/)).toBeTruthy());
  expect(stops()).toContain("Retry budget for app-server restarts");
  expect(within(threads()).queryByRole("button", { name: /^Snoozed / })).toBeNull();
});

test("the project filter narrows Home to one project and is remembered", async () => {
  const storage = memoryKeyValue();
  const view = await openHome(workbenchApp({ storage }));
  await userEvent.click(screen.getByRole("button", { name: "Project filter: All projects" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "relay" }));

  await waitFor(() =>
    expect(order()).toEqual([
      "Retry budget for app-server restarts",
      "Backpressure on broadcast fan-out",
    ]),
  );
  view.unmount();

  await openHome(workbenchApp({ storage }));
  expect(await screen.findByRole("button", { name: "Project filter: relay" })).toBeTruthy();
  await waitFor(() => expect(order()).toContain("Backpressure on broadcast fan-out"));
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
