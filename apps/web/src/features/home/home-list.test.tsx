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

/** The panel's tab named `name` ("Active", "Settled"), whatever its count. */
const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name} \\d`) });
/** Show the panel's `name` tab. */
const showTab = (name: string) => userEvent.click(tab(name));
/** Wait for the Settled tab to count `count` threads. */
const settledCount = (count: number) =>
  waitFor(() => expect(tab("Settled").textContent).toBe(`Settled ${count}`));
/** Every keyboard stop of the list as it reads, rows by title and group headings by name. */
const stops = () =>
  [...threads().querySelectorAll<HTMLElement>("[data-row-focus], [data-section-toggle]")].map(
    (stop) => stop.getAttribute("aria-label")?.split(".")[0] ?? stop.textContent,
  );

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

test("Active groups what needs you, then what runs, then the rest by day, across projects", async () => {
  await openHome(workbenchApp());
  // The groups cross project boundaries rather than collecting each project together.
  expect(stops()).toEqual([
    "Needs you 3",
    "Partial refunds double-count tax",
    "Approval sheet loses its state on rotate",
    "Retry budget for app-server restarts",
    "Running 3",
    "Dedupe thread events after reconnect",
    "Rewrite the install page for the daemon",
    "Backpressure on broadcast fan-out",
    "Earlier 1",
    "Invoice PDF locale fallback",
  ]);
  expect(tab("Active").textContent).toBe("Active 7");
  // The finished thread's PR merged, so the daemon has settled it into the Settled tab.
  expect(order()).not.toContain("Bump Codex app-server to 0.48");
  await settledCount(1);
  await showTab("Settled");
  expect(tab("Settled").getAttribute("aria-selected")).toBe("true");
  expect(order()).toEqual(["Bump Codex app-server to 0.48"]);
});

test("a folded group keeps its heading and count and hides its threads", async () => {
  await openHome(workbenchApp());
  const running = within(threads()).getByRole("button", { name: "Running 3" });
  await userEvent.click(running);
  expect(running.getAttribute("aria-expanded")).toBe("false");
  await waitFor(() => expect(order()).not.toContain("Dedupe thread events after reconnect"));
  expect(order()).toContain("Partial refunds double-count tax");
  await userEvent.click(within(threads()).getByRole("button", { name: "Running 3" }));
  expect(await within(threads()).findByRole("link", { name: /^Dedupe thread/ })).toBeTruthy();
});

test("a pinned thread leads the list, ahead of threads that need you", async () => {
  const app = workbenchApp();
  await openHome(app);
  await app.client.command({
    type: "thread.pin",
    threadId: ThreadId.parse("thread-install-page"),
    pinned: true,
  });
  await waitFor(() => expect(order()[0]).toBe("Rewrite the install page for the daemon"));
  expect(order()[1]).toBe("Partial refunds double-count tax");
  expect(card(/^Rewrite the install page for the daemon\..*Pinned/)).toBeTruthy();
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

/** Bring the settled thread back to the Active tab, done and at rest. */
async function unsettleBump() {
  await showTab("Settled");
  await rowAction("Unsettle", "Bump Codex app-server to 0.48");
  await settledCount(0);
  await showTab("Active");
  await within(threads()).findByRole("link", { name: /^Bump Codex/ });
}

test("finished tasks follow the work in hand without a Recent heading", async () => {
  await openHome(workbenchApp());
  await unsettleBump();
  expect(within(threads()).queryByText("Recent", { exact: true })).toBeNull();
  expect(before("Partial refunds double-count tax", "Bump Codex app-server to 0.48")).toBe(true);
  expect(before("Dedupe thread events after reconnect", "Bump Codex app-server to 0.48")).toBe(
    true,
  );
});

test("Up and Down (and j and k) move between rows and group headings", async () => {
  await openHome(workbenchApp());
  const heading = within(threads()).getByRole("button", { name: "Needs you 3" });
  const rows = within(threads()).getAllByRole("link");
  const [first, second, third] = rows;
  if (!first || !second || !third) throw new Error("expected three rows");
  first.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(second);
  await userEvent.keyboard("k");
  expect(document.activeElement).toBe(first);
  await userEvent.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(heading);
  // Up from the top stays put.
  await userEvent.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(heading);
  third.focus();
  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(within(threads()).getByRole("button", { name: "Running 3" }));
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

test("the panel reopens on the tab the person left it on, across a reload", async () => {
  const storage = memoryKeyValue();
  const view = await openHome(workbenchApp({ storage }));
  expect(tab("Active").getAttribute("aria-selected")).toBe("true");
  await showTab("Settled");
  expect(card(/^Bump Codex app-server to 0.48/)).toBeTruthy();
  view.unmount();

  await openHome(workbenchApp({ storage }));
  expect(tab("Settled").getAttribute("aria-selected")).toBe("true");
  expect(card(/^Bump Codex app-server to 0.48/)).toBeTruthy();
  await showTab("Active");
  await waitFor(() =>
    expect(within(threads()).queryByRole("link", { name: /^Bump Codex/ })).toBeNull(),
  );
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

test("Settle drops a finished thread into Settled on the daemon and Unsettle puts it back", async () => {
  const app = workbenchApp();
  const settledAt = () => {
    const view = app.daemon.snapshot({ kind: "threads" });
    return view?.kind === "threads" ? view.threads["thread-bump-codex"]?.settledAt : undefined;
  };
  await openHome(app);
  await unsettleBump();
  expect(order()).toContain("Bump Codex app-server to 0.48");
  await waitFor(() => expect(settledAt()).toBeUndefined());

  await rowAction("Settle", "Bump Codex app-server to 0.48");
  await settledCount(1);
  await waitFor(() => expect(order()).not.toContain("Bump Codex app-server to 0.48"));
  await waitFor(() => expect(settledAt()).toBeDefined());
});

test("a settled thread comes back to the list as soon as it moves again", async () => {
  const app = workbenchApp();
  await openHome(app);
  await unsettleBump();
  await rowAction("Settle", "Bump Codex app-server to 0.48");
  await settledCount(1);

  // New work on it: the agent starts another turn and the thread is working again.
  app.daemon.apply("thread-bump-codex", [
    { type: "turn.started", agent: "root", nativeTurnId: "follow-up", trigger: "user" },
  ]);
  await settledCount(0);
  // Under Running, never under a day group: its tree is working.
  await waitFor(() =>
    expect(stops().indexOf("Bump Codex app-server to 0.48")).toBeLessThan(
      stops().findIndex((stop) => stop?.startsWith("Earlier")),
    ),
  );
  expect(card(/^Bump Codex app-server to 0\.48\. Working/)).toBeTruthy();
});

test("Settled lists settled threads without the settle rule, which lives in Settings", async () => {
  const app = workbenchApp();
  await openHome(app);
  await showTab("Settled");
  expect(card(/^Bump Codex/)).toBeTruthy();
  expect(screen.queryByText(/Threads that need you never settle/)).toBeNull();
  expect(screen.queryByRole("button", { name: "When done threads settle" })).toBeNull();
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
