import { facts, workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const titles = workbench().map((scenario) => scenario.thread.title);
/** Thread titles in the order the Home list shows them (rows, then settled rows if open). */
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
/** The panel's title: "Threads" for the tree, else the focused list's name. */
const panelTitle = () => screen.getByRole("heading", { level: 2 }).textContent;
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
  await within(nav).findAllByRole("link");
  return view;
}

function workbenchApp(options: Parameters<typeof harness>[0] = {}) {
  const app = harness(options);
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  return app;
}

test("the Inbox holds what needs you, and each project lists its other threads", async () => {
  await openHome(workbenchApp());
  expect(stops()).toEqual([
    "Inbox, 3 need you",
    "Partial refunds double-count tax",
    "Approval sheet loses its state on rotate",
    "Retry budget for app-server restarts",
    "Running, 3",
    "Recent, 0",
    "[ace]",
    "Dedupe thread events after reconnect",
    "1 settled",
    "[relay]",
    "Backpressure on broadcast fan-out",
    "[billing-api]",
    "Invoice PDF locale fallback",
    "[ace-mobile]",
    "[docs-site]",
    "Rewrite the install page for the daemon",
  ]);
  // A request shows once, in the Inbox, never again under its project.
  expect(order().filter((title) => title === "Retry budget for app-server restarts")).toHaveLength(
    1,
  );
  // The settled thread waits under its project's "1 settled".
  expect(order()).not.toContain("Bump Codex app-server to 0.48");
  await userEvent.click(head("1 settled"));
  await waitFor(() =>
    expect(before("Dedupe thread events after reconnect", "Bump Codex app-server to 0.48")).toBe(
      true,
    ),
  );
  expect(before("Bump Codex app-server to 0.48", "Backpressure on broadcast fan-out")).toBe(true);
});

test("a folded project keeps its heading and Inbox count, hides its threads, across a reload", async () => {
  const storage = memoryKeyValue();
  const view = await openHome(workbenchApp({ storage }));
  const relay = within(threads()).getByRole("button", { name: /^relay/ });
  await userEvent.click(relay);
  expect(relay.getAttribute("aria-expanded")).toBe("false");
  await waitFor(() => expect(order()).not.toContain("Backpressure on broadcast fan-out"));
  // Folded, it says how many of its threads wait in the Inbox.
  expect(head(/^relay.*, 1 in the Inbox/)).toBeTruthy();
  view.unmount();

  await openHome(workbenchApp({ storage }));
  expect(head(/^relay/).getAttribute("aria-expanded")).toBe("false");
  expect(order()).not.toContain("Backpressure on broadcast fan-out");
  await userEvent.click(head(/^relay/));
  expect(await within(threads()).findByRole("link", { name: /^Backpressure/ })).toBeTruthy();
});

test("Running lists every thread at work across projects, each naming its project", async () => {
  await openHome(workbenchApp());
  await userEvent.click(head("Running, 3"));
  expect(panelTitle()).toBe("Running");
  await waitFor(() =>
    expect(order()).toEqual([
      "Dedupe thread events after reconnect",
      "Rewrite the install page for the daemon",
      "Backpressure on broadcast fan-out",
    ]),
  );
  expect(within(card(/^Dedupe thread/)).getByText("ace")).toBeTruthy();
  expect(within(card(/^Backpressure/)).getByText("relay")).toBeTruthy();
});

test("a project opens as its own list with Active and Settled tabs; Back and Escape return", async () => {
  await openHome(workbenchApp());
  await userEvent.click(screen.getByRole("button", { name: "Open ace" }));
  expect(panelTitle()).toBe("ace");
  // Inside its project a row doesn't repeat the project.
  await waitFor(() => expect(order()).toEqual(["Dedupe thread events after reconnect"]));
  expect(within(card(/^Dedupe thread/)).queryByText("ace")).toBeNull();
  await userEvent.click(screen.getByRole("tab", { name: "Settled" }));
  await waitFor(() => expect(order()).toEqual(["Bump Codex app-server to 0.48"]));
  await userEvent.click(screen.getByRole("button", { name: "Back to Threads" }));
  expect(panelTitle()).toBe("Threads");
  expect(head("Running, 3")).toBeTruthy();

  await userEvent.click(head("Running, 3"));
  expect(panelTitle()).toBe("Running");
  // Escape outside the search field goes back too.
  card(/^Dedupe thread/).focus();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(panelTitle()).toBe("Threads"));
});

test("a window comes back to the list it was focused on, across a reload", async () => {
  const storage = memoryKeyValue();
  const windowStorage = memoryKeyValue();
  const view = await openHome(workbenchApp({ storage, windowStorage }));
  await userEvent.click(screen.getByRole("button", { name: "Open relay" }));
  expect(panelTitle()).toBe("relay");
  view.unmount();

  const again = await openHome(workbenchApp({ storage, windowStorage }));
  expect(panelTitle()).toBe("relay");
  again.unmount();

  // Another window keeps its own: it opens on the tree.
  await openHome(workbenchApp({ storage, windowStorage: memoryKeyValue() }));
  expect(panelTitle()).toBe("Threads");
});

test("projects with only settled threads fold under Quiet projects, which opens each", async () => {
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
  await userEvent.click(
    await within(threads()).findByRole("button", { name: /^notes, 1 settled/ }),
  );
  expect(panelTitle()).toBe("notes");
  expect(screen.getByRole("tab", { name: "Settled" }).getAttribute("aria-selected")).toBe("true");
  await waitFor(() =>
    expect(within(threads()).getByRole("link", { name: /^Write release notes/ })).toBeTruthy(),
  );
});

test("a pinned thread leads its project, ahead of running work", async () => {
  const app = workbenchApp();
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
  const refund = card(/^Partial refunds double-count tax/);
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

/** Bring the settled thread back into its project, done and at rest. */
async function unsettleBump() {
  await userEvent.click(head("1 settled"));
  await within(threads()).findByRole("link", { name: /^Bump Codex/ });
  await rowAction("Unsettle", "Bump Codex app-server to 0.48");
  await waitFor(() =>
    expect(within(threads()).queryByRole("button", { name: "1 settled" })).toBeNull(),
  );
  await within(threads()).findByRole("link", { name: /^Bump Codex/ });
}

test("finished work follows running work in its project", async () => {
  await openHome(workbenchApp());
  await unsettleBump();
  expect(before("Dedupe thread events after reconnect", "Bump Codex app-server to 0.48")).toBe(
    true,
  );
  expect(before("Bump Codex app-server to 0.48", "Backpressure on broadcast fan-out")).toBe(true);
});

test("Up and Down (and j and k) move between rows, headings and places", async () => {
  await openHome(workbenchApp());
  const inbox = head(/^Inbox/);
  const rows = within(threads()).getAllByRole("link");
  const [first, second, third] = rows;
  if (!first || !second || !third) throw new Error("expected three rows");
  first.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(second);
  await userEvent.keyboard("k");
  expect(document.activeElement).toBe(first);
  await userEvent.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(inbox);
  third.focus();
  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(head("Running, 3"));
  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(head("Recent, 0"));
  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(head(/^ace, 1 running/));
  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(card(/^Dedupe thread events/));
});

test("a row's name says its status, provider and subagents, branch, pull request, project and machine", async () => {
  await openHome(workbenchApp());
  expect(
    await within(threads()).findByRole("link", {
      name: /^Partial refunds double-count tax\. Waiting for your approval, Claude Code, .*Pull request #77/,
    }),
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
  await openHome(workbenchApp());
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
  await userEvent.click(card(/^Partial refunds double-count tax/));
  await waitFor(() => expect(current()).toEqual(["Partial refunds double-count tax"]));
});

test("hovering a row's link shows what its marks mean in a tooltip", async () => {
  await openHome(workbenchApp());
  await userEvent.hover(await within(threads()).findByRole("link", { name: /^Partial refunds/ }));
  const tip = await screen.findByLabelText(/^Details for /);
  expect(tip.textContent).toContain("billing-api");
  const prs = within(tip).getByRole("list", {
    name: "Pull requests in github.com/acme/billing-api",
  });
  expect(within(prs).getByRole("listitem", { name: /^#77, open\b/ })).toBeTruthy();
});

test("Settle drops a finished thread into its project's settled ones and Unsettle puts it back", async () => {
  const app = workbenchApp();
  const settledAt = () => {
    const view = app.daemon.snapshot({ kind: "threads" });
    return view?.kind === "threads" ? view.threads["thread-bump-codex"]?.settledAt : undefined;
  };
  await openHome(app);
  await unsettleBump();
  await waitFor(() => expect(settledAt()).toBeUndefined());

  await rowAction("Settle", "Bump Codex app-server to 0.48");
  expect(await within(threads()).findByRole("button", { name: "1 settled" })).toBeTruthy();
  await waitFor(() => expect(settledAt()).toBeDefined());
});

test("a settled thread comes back to its project as soon as it moves again, as running", async () => {
  const app = workbenchApp();
  await openHome(app);
  expect(head("1 settled")).toBeTruthy();

  // New work on it: the agent starts another turn and the thread is working again.
  app.daemon.apply("thread-bump-codex", [
    { type: "turn.started", agent: "root", nativeTurnId: "follow-up", trigger: "user" },
  ]);
  await waitFor(() => expect(head("Running, 4")).toBeTruthy());
  // Under its project, never in the Inbox and never as Done: its tree is working.
  expect(card(/^Bump Codex app-server to 0\.48\. Working/)).toBeTruthy();
  expect(before("Bump Codex app-server to 0.48", "Backpressure on broadcast fan-out")).toBe(true);
});

test("a snoozed request stays in the list with its wake time; Wake now clears it", async () => {
  const app = workbenchApp();
  const snoozedUntil = () => {
    const view = app.daemon.snapshot({ kind: "threads" });
    return view?.kind === "threads" ? view.threads["thread-retry-budget"]?.snoozedUntil : undefined;
  };
  await openHome(app);
  await within(threads()).findByRole("link", { name: /Retry budget/ });
  await userEvent.pointer({ keys: "[MouseRight]", target: card(/^Retry budget/) });
  await userEvent.hover(await screen.findByRole("menuitem", { name: /^Snooze/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Tomorrow/ }));
  // A thread waiting on the person is never folded away: it keeps its place, marked snoozed.
  await waitFor(() => expect(card(/^Retry budget.*Snoozed until tomorrow/)).toBeTruthy());
  expect(within(threads()).queryByRole("button", { name: /^Snoozed / })).toBeNull();
  expect(before("Retry budget for app-server restarts", "Backpressure on broadcast fan-out")).toBe(
    true,
  );
  await waitFor(() => expect(snoozedUntil()).toBeDefined());

  await userEvent.pointer({ keys: "[MouseRight]", target: card(/^Retry budget/) });
  await userEvent.hover(await screen.findByRole("menuitem", { name: /^Snooze/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Wake now" }));
  await waitFor(() =>
    expect(card(/^Retry budget/).getAttribute("aria-label")).not.toContain("Snoozed"),
  );
  await waitFor(() => expect(snoozedUntil()).toBeUndefined());
});

test("the project filter narrows Home to one project and is remembered", async () => {
  const storage = memoryKeyValue();
  const view = await openHome(workbenchApp({ storage }));
  await within(threads()).findByRole("link", { name: /Retry budget/ });
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
  await waitFor(() => expect(order()).toHaveLength(2));
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
