import { facts, workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThreadId } from "@ace/protocol";
import { expect, test, vi } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const titles = workbench().map((scenario) => scenario.thread.title);
/** Thread titles in the order the Home list shows them (rows, then settled rows if open). */
const order = () =>
  within(threads())
    .queryAllByRole("link")
    .map((link) => titles.find((title) => link.textContent?.includes(title)));
const card = (title: string | RegExp) => within(threads()).getByRole("link", { name: title });

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
  const settled = screen.getByRole("button", { name: "Settled (1)" });
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

test("a task row shows its project badge, status, title, branch, changes and provider", async () => {
  await openHome(workbenchApp());
  const refund = card(/^Partial refunds double-count tax/);
  expect(within(refund).getByText("billing-api")).toBeTruthy();
  expect(within(refund).getByText("BA")).toBeTruthy();
  expect(within(refund).getByText("Needs you")).toBeTruthy();
  expect(within(refund).getByText("fix/refund-tax")).toBeTruthy();
  // A linked pull request stands in for the diff.
  expect(refund.textContent).toContain("#77");

  const install = card(/^Rewrite the install page for the daemon/);
  expect(within(install).getByText("DS")).toBeTruthy();
  expect(within(install).getByText("docs/install-daemon")).toBeTruthy();
  expect(within(install).getByText("+120")).toBeTruthy();
  expect(within(install).getByText("−88")).toBeTruthy();

  const dedupe = card(/^Dedupe thread events after reconnect/);
  expect(within(dedupe).getByText(/^Working/)).toBeTruthy();
  // Its subagents count beside the provider's mark.
  expect(within(dedupe).getByText("2")).toBeTruthy();
});

test("a working thread's pill counts the seconds it has been working", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const app = harness({ clock: () => Date.now() });
    app
      .play({
        thread: {
          id: "thread-fresh",
          workspaceId: "relay",
          title: "Fresh task",
          provider: "claude",
        },
        steps: [{ kind: "facts", facts: [facts.rootAgent("claude"), facts.turn("root")] }],
      })
      .runUntilBlocked();
    await openHome(app);
    const seconds = () => {
      const text = within(card(/^Fresh task/)).getByText(/^Working/).textContent ?? "";
      return Number(/(\d+)s$/.exec(text)?.[1]);
    };
    const start = seconds();
    expect(start).toBeLessThan(5);
    await vi.advanceTimersByTimeAsync(6_000);
    await waitFor(() => expect(seconds()).toBeGreaterThanOrEqual(start + 5));
  } finally {
    vi.useRealTimers();
  }
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
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Settled (1)" }));
  await userEvent.keyboard("{Enter}{ArrowDown}");
  expect(document.activeElement).toBe(card(/^Bump Codex app-server to 0.48/));
});

test("a row's name says its status, provider and subagents, branch, pull request, changes, project and machine", async () => {
  await openHome(workbenchApp());
  expect(
    await within(threads()).findByRole("link", {
      name: /^Partial refunds double-count tax\. Needs you, Claude Code, .*Pull request #77/,
    }),
  ).toBeTruthy();
  expect(
    card(
      /^Dedupe thread events after reconnect\. Working, Claude Code · 2 subagents running, Worktree fix\/replay-dedupe/,
    ),
  ).toBeTruthy();
  expect(card(/^Backpressure on broadcast fan-out\..*Running on build-box/)).toBeTruthy();
  expect(
    card(
      /^Rewrite the install page for the daemon\..*Branch docs\/install-daemon, 120 lines added, 88 removed, Project docs-site/,
    ),
  ).toBeTruthy();
});

test("hovering a row's link shows what its marks mean in a tooltip", async () => {
  await openHome(workbenchApp());
  await userEvent.hover(await within(threads()).findByRole("link", { name: /^Partial refunds/ }));
  const tip = await screen.findByRole("tooltip");
  expect(tip.textContent).toContain("Needs you");
  expect(tip.textContent).toContain("Pull request #77");
});

test("Settle drops a finished thread into Settled on the daemon and Undo puts it back", async () => {
  const app = workbenchApp();
  await openHome(app);
  await userEvent.click(await screen.findByRole("button", { name: "Settled (1)" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Unsettle Bump Codex app-server to 0.48" }),
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Settled (0)" })).toBeTruthy());
  expect(order()).toContain("Bump Codex app-server to 0.48");

  await userEvent.click(
    screen.getByRole("button", { name: "Settle Bump Codex app-server to 0.48" }),
  );
  expect(await screen.findByText("Settled · Bump Codex app-server to 0.48")).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("button", { name: "Settled (1)" })).toBeTruthy());
  const settledAt = () => {
    const view = app.daemon.snapshot({ kind: "threads" });
    return view?.kind === "threads" ? view.threads["thread-bump-codex"]?.settledAt : undefined;
  };
  expect(settledAt()).toBeDefined();

  // This toast's Undo: the Unsettle before it offers one too.
  const toast = screen.getByText("Settled · Bump Codex app-server to 0.48").closest("[role]");
  if (!(toast instanceof HTMLElement)) throw new Error("no toast");
  await userEvent.click(within(toast).getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Settled (0)" })).toBeTruthy());
  expect(settledAt()).toBeUndefined();
});

test("a thread that is still working offers no Settle", async () => {
  await openHome(workbenchApp());
  expect(
    screen.queryByRole("button", { name: "Settle Dedupe thread events after reconnect" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Snooze Dedupe thread events after reconnect" }),
  ).toBeTruthy();
});

test("a settled thread comes back to the list as soon as it moves again", async () => {
  const app = workbenchApp();
  await openHome(app);
  await userEvent.click(await screen.findByRole("button", { name: "Settled (1)" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Unsettle Bump Codex app-server to 0.48" }),
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Settled (0)" })).toBeTruthy());
  await userEvent.click(
    screen.getByRole("button", { name: "Settle Bump Codex app-server to 0.48" }),
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Settled (1)" })).toBeTruthy());

  // New work on it: the agent starts another turn and the thread is working again.
  app.daemon.apply("thread-bump-codex", [
    { type: "turn.started", agent: "root", nativeTurnId: "follow-up", trigger: "user" },
  ]);
  await waitFor(() => expect(screen.getByRole("button", { name: "Settled (0)" })).toBeTruthy());
  expect(card(/^Bump Codex app-server to 0\.48\. Working/)).toBeTruthy();
});

test("Settled lists settled threads without the settle rule, which lives in Settings", async () => {
  const app = workbenchApp();
  await openHome(app);
  await userEvent.click(await screen.findByRole("button", { name: "Settled (1)" }));
  expect(await screen.findByRole("button", { name: /^Unsettle / })).toBeTruthy();
  expect(screen.queryByText(/Threads that need you never settle/)).toBeNull();
  expect(screen.queryByRole("button", { name: "When done threads settle" })).toBeNull();
});

test("Snooze sinks a thread below the others with its wake time; Undo wakes it", async () => {
  await openHome(workbenchApp());
  await within(threads()).findByRole("link", { name: /Retry budget/ });
  await userEvent.click(
    screen.getByRole("button", { name: "Snooze Retry budget for app-server restarts" }),
  );
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

test("Tab walks a row's link, its Snooze, then the next row", async () => {
  await openHome(workbenchApp());
  const [first, second] = within(threads()).getAllByRole("link");
  if (!first || !second) throw new Error("expected two rows");
  first.focus();
  await userEvent.tab();
  expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Snooze /);
  await userEvent.tab();
  expect(document.activeElement).toBe(second);
});

test("a row names its branch cut in the middle, and no branch when it is on main", async () => {
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
  expect(within(hashed).getByText("ace/33594883…a4fc70aeea5")).toBeTruthy();
  // The whole name is still in the row's name and its tooltip.
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
