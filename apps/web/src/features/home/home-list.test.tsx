import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const titles = workbench().map((scenario) => scenario.thread.title);
/** Thread titles in the order the Home list shows them (rows, then settled rows if open). */
const order = () =>
  within(threads())
    .queryAllByRole("link")
    .map((link) => titles.find((title) => link.textContent?.includes(title)));
const card = (title: string | RegExp) => within(threads()).getByRole("link", { name: title });

/** The titles of the rows marked as the open thread. */
const current = () =>
  within(threads())
    .getAllByRole("link", { current: "page" })
    .map((link) => titles.find((title) => link.textContent?.includes(title)));

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

test("Home lists every project's threads as one list, in the order of what needs you", async () => {
  await openHome(workbenchApp());
  // No folders: threads from billing-api, ace-mobile, relay, ace and docs-site interleave, by
  // what needs you, then work in motion, then trouble, then the rest.
  expect(order()).toEqual([
    "Partial refunds double-count tax",
    "Approval sheet loses its state on rotate",
    "Retry budget for app-server restarts",
    "Backpressure on broadcast fan-out",
    "Dedupe thread events after reconnect",
    "Rewrite the install page for the daemon",
    "Invoice PDF locale fallback",
  ]);
  expect(within(threads()).queryByRole("button", { name: /^Show more/ })).toBeNull();
  // The finished thread's PR merged, so the daemon has settled it out of the way.
  const settled = screen.getByRole("button", { name: "Settled 1" });
  expect(settled.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(settled);
  expect(card(/Bump Codex app-server to 0.48/)).toBeTruthy();
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
  expect(within(refund).getByText("fix/refund-tax")).toBeTruthy();
  expect(refund.getAttribute("aria-label") ?? refund.textContent).toContain(
    "Waiting for your approval",
  );
  // Its linked pull request shows by number, and its name exposes the branch and project.
  expect(refund.textContent).toContain("77");
  expect(refund.getAttribute("aria-label")).toContain("fix/refund-tax");
  expect(refund.getAttribute("aria-label")).toContain("billing-api");
  expect(within(refund).queryByText("billing-api")).toBeNull();

  // Working rows expose their worktree and subagents too.
  const dedupe = card(/^Dedupe thread events after reconnect/);
  expect(within(dedupe).getByText("fix/replay-dedupe")).toBeTruthy();
  expect(within(dedupe).getByText("2")).toBeTruthy();
  expect(dedupe.getAttribute("aria-label") ?? dedupe.textContent).toContain(
    "Waiting on 2 subagents",
  );
  // The branch and changes stay available on the row.
  const install = card(/^Rewrite the install page for the daemon/);
  expect(within(install).getByRole("img", { name: "OpenCode" })).toBeTruthy();
  expect(within(install).getByText("docs/install-daemon")).toBeTruthy();
  expect(within(install).getByText("+120")).toBeTruthy();
});

/** Bring the settled thread back to the list, done and at rest. */
async function unsettleBump() {
  await userEvent.click(await screen.findByRole("button", { name: "Settled 1" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Unsettle Bump Codex app-server to 0.48" }),
  );
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Settled / })).toBeNull());
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

test("Up and Down (and j and k) move between rows, past the Settled heading", async () => {
  await openHome(workbenchApp());
  const rows = within(threads()).getAllByRole("link");
  const [first, second] = rows;
  if (!first || !second) throw new Error("expected two rows");
  first.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(second);
  await userEvent.keyboard("k");
  expect(document.activeElement).toBe(first);
  // Up from the top stays put.
  await userEvent.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(first);
  const last = rows.at(-1);
  last?.focus();
  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Settled 1" }));
  await userEvent.keyboard("{Enter}{ArrowDown}");
  expect(document.activeElement).toBe(card(/^Bump Codex app-server to 0.48/));
});

test("a row's name says its status, provider and subagents, branch, pull request, changes, project and machine", async () => {
  await openHome(workbenchApp());
  expect(
    await within(threads()).findByRole("link", {
      name: /^Partial refunds double-count tax\. Waiting for your approval, Claude Code, .*Pull request #77/,
    }),
  ).toBeTruthy();
  expect(
    card(
      /^Dedupe thread events after reconnect\. Waiting on 2 subagents, Claude Code · 2 subagents running, Worktree fix\/replay-dedupe/,
    ),
  ).toBeTruthy();
  expect(card(/^Backpressure on broadcast fan-out\..*Running on build-box/)).toBeTruthy();
  expect(
    card(
      /^Rewrite the install page for the daemon\..*Branch docs\/install-daemon, 120 lines added, 88 removed, Project docs-site/,
    ),
  ).toBeTruthy();
});

test("hovering a row offers one quick action in place of its marks, named by its tooltip", async () => {
  await openHome(workbenchApp());
  await unsettleBump();
  await userEvent.hover(card(/^Bump Codex app-server to 0.48/));
  // Finished: Settle. Its accessible name says which thread; its tooltip just what it does.
  const settle = screen.getByRole("button", { name: "Settle Bump Codex app-server to 0.48" });
  expect(settle.textContent).toBe("");
  await userEvent.hover(settle);
  await waitFor(() =>
    expect(screen.getAllByRole("tooltip").map((tip) => tip.textContent)).toContain("Settle"),
  );
  await userEvent.hover(card(/^Dedupe thread events after reconnect/));
  const busy = screen.getByRole("button", { name: "Settle Dedupe thread events after reconnect" });
  expect(busy.getAttribute("aria-disabled")).toBe("true");
  await userEvent.hover(busy);
  await waitFor(() =>
    expect(screen.getAllByRole("tooltip").map((tip) => tip.textContent)).toContain(
      "Settle after the task finishes",
    ),
  );
});

test("Settled stays open or closed as the person left it, across a reload", async () => {
  const storage = memoryKeyValue();
  const view = await openHome(workbenchApp({ storage }));
  const toggle = await screen.findByRole("button", { name: "Settled 1" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(toggle);
  expect(card(/^Bump Codex app-server to 0.48/)).toBeTruthy();
  view.unmount();

  await openHome(workbenchApp({ storage }));
  const reopened = await screen.findByRole("button", { name: "Settled 1" });
  expect(reopened.getAttribute("aria-expanded")).toBe("true");
  expect(card(/^Bump Codex app-server to 0.48/)).toBeTruthy();
  await userEvent.click(reopened);
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
  const tip = await screen.findByRole("tooltip");
  expect(tip.textContent).toContain("Waiting for your approval");
  expect(tip.textContent).toContain("Pull request #77");
});

test("Settle drops a finished thread into Settled on the daemon and Undo puts it back", async () => {
  const app = workbenchApp();
  await openHome(app);
  await userEvent.click(await screen.findByRole("button", { name: "Settled 1" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Unsettle Bump Codex app-server to 0.48" }),
  );
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Settled / })).toBeNull());
  expect(order()).toContain("Bump Codex app-server to 0.48");

  await userEvent.click(
    screen.getByRole("button", { name: "Settle Bump Codex app-server to 0.48" }),
  );
  expect(await screen.findByText("Settled · Bump Codex app-server to 0.48")).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("button", { name: "Settled 1" })).toBeTruthy());
  const settledAt = () => {
    const view = app.daemon.snapshot({ kind: "threads" });
    return view?.kind === "threads" ? view.threads["thread-bump-codex"]?.settledAt : undefined;
  };
  expect(settledAt()).toBeDefined();

  // This toast's Undo: the Unsettle before it offers one too.
  const toast = screen.getByText("Settled · Bump Codex app-server to 0.48").closest("[role]");
  if (!(toast instanceof HTMLElement)) throw new Error("no toast");
  await userEvent.click(within(toast).getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Settled / })).toBeNull());
  expect(settledAt()).toBeUndefined();
});

test("a task still working cannot settle through its quick action", async () => {
  await openHome(workbenchApp());
  const settle = screen.getByRole("button", {
    name: "Settle Dedupe thread events after reconnect",
  });
  await userEvent.click(settle);
  expect(card(/^Dedupe thread events after reconnect/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Settled 1" })).toBeTruthy();
});

test("a settled thread comes back to the list as soon as it moves again", async () => {
  const app = workbenchApp();
  await openHome(app);
  await userEvent.click(await screen.findByRole("button", { name: "Settled 1" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Unsettle Bump Codex app-server to 0.48" }),
  );
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Settled / })).toBeNull());
  await userEvent.click(
    screen.getByRole("button", { name: "Settle Bump Codex app-server to 0.48" }),
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Settled 1" })).toBeTruthy());

  // New work on it: the agent starts another turn and the thread is working again.
  app.daemon.apply("thread-bump-codex", [
    { type: "turn.started", agent: "root", nativeTurnId: "follow-up", trigger: "user" },
  ]);
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Settled / })).toBeNull());
  expect(card(/^Bump Codex app-server to 0\.48\. Working/)).toBeTruthy();
});

test("Settled lists settled threads without the settle rule, which lives in Settings", async () => {
  const app = workbenchApp();
  await openHome(app);
  await userEvent.click(await screen.findByRole("button", { name: "Settled 1" }));
  expect(await screen.findByRole("button", { name: /^Unsettle / })).toBeTruthy();
  expect(screen.queryByText(/Threads that need you never settle/)).toBeNull();
  expect(screen.queryByRole("button", { name: "When done threads settle" })).toBeNull();
});

test("Snooze sinks a thread below the others with its wake time; Undo wakes it", async () => {
  await openHome(workbenchApp());
  await within(threads()).findByRole("link", { name: /Retry budget/ });
  await userEvent.pointer({ keys: "[MouseRight]", target: card(/^Retry budget/) });
  await userEvent.hover(await screen.findByRole("menuitem", { name: /^Snooze/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Tomorrow/ }));
  // The row keeps its place while the pointer is on the list, and sinks once it leaves.
  await waitFor(() => expect(card(/^Retry budget.*Snoozed until tomorrow/)).toBeTruthy());
  expect(before("Retry budget for app-server restarts", "Backpressure on broadcast fan-out")).toBe(
    true,
  );
  const list = threads().querySelector("[data-virtual-viewport]");
  if (!(list instanceof HTMLElement)) throw new Error("no list");
  await userEvent.unhover(list);

  await waitFor(() =>
    expect(
      before("Backpressure on broadcast fan-out", "Retry budget for app-server restarts"),
    ).toBe(true),
  );
  expect(card(/^Retry budget.*Snoozed until tomorrow/)).toBeTruthy();
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() =>
    expect(
      before("Retry budget for app-server restarts", "Backpressure on broadcast fan-out"),
    ).toBe(true),
  );
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

test("Tab walks a task link, its single quick action, then the next task", async () => {
  await openHome(workbenchApp());
  const [first, second] = within(threads()).getAllByRole("link");
  if (!first || !second) throw new Error("expected two rows");
  first.focus();
  await userEvent.tab();
  expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Settle /);
  await userEvent.tab();
  expect(document.activeElement).toBe(second);
});

test("a row's name and tooltip give its whole branch, and no branch when it is on main", async () => {
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
  await openHome(app);

  const hashed = card(/^Support spare-part materials/);
  expect(hashed.getAttribute("aria-label") ?? hashed.textContent).toContain(
    "Worktree ace/33594883e2b3ea4fc70aeea5",
  );
  await userEvent.hover(hashed);
  expect((await screen.findByRole("tooltip")).textContent).toContain(
    "Worktree ace/33594883e2b3ea4fc70aeea5",
  );

  const onMain = card(/^Tidy the README/);
  expect(onMain.textContent).not.toContain("main");
});
