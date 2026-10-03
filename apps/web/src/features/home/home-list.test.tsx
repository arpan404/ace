import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const titles = workbench().map((scenario) => scenario.thread.title);
/** Thread titles in the order the Home list shows them (cards, then settled rows if open). */
const order = () =>
  within(threads())
    .queryAllByRole("link")
    .map((link) => titles.find((title) => link.textContent?.includes(title)));
const card = (title: string | RegExp) => within(threads()).getByRole("link", { name: title });

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

test("Home lists what needs you first, then work in motion, then trouble; done work settles", async () => {
  await openHome(workbenchApp());
  expect(order()).toEqual([
    "Partial refunds double-count tax",
    "Approval sheet loses its state on rotate",
    "Retry budget for app-server restarts",
    // Working and waiting rank together, by when each last moved: the hero thread's
    // subagent picked up work 35s ago, the install page has been drafting for minutes.
    "Backpressure on broadcast fan-out",
    "Dedupe thread events after reconnect",
    "Rewrite the install page for the daemon",
    "Invoice PDF locale fallback",
  ]);
  // The finished thread's PR merged, so the daemon has settled it out of the way.
  const settled = screen.getByRole("button", { name: "Settled (1)" });
  expect(settled.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(settled);
  expect(card(/Bump Codex app-server to 0.48/)).toBeTruthy();
});

test("a card carries project, branch and PR, the status in words and the running subagents", async () => {
  await openHome(workbenchApp());
  const refund = await within(threads()).findByRole("link", { name: /Partial refunds/ });
  expect(refund.textContent).toContain("billing-api");
  expect(refund.textContent).toContain("fix/refund-tax");
  expect(refund.textContent).toContain("#77");
  expect(within(refund).getByText("Needs you")).toBeTruthy();
  const dedupe = card(/Dedupe thread events/);
  expect(within(dedupe).getByText("Working")).toBeTruthy();
  expect(within(dedupe).getByText("Claude Code · 2 subagents running")).toBeTruthy();
  expect(
    within(card(/Backpressure/)).getByRole("img", { name: "Running on build-box" }),
  ).toBeTruthy();
});

test("Settle drops a finished thread into Settled on the daemon and Undo puts it back", async () => {
  const app = workbenchApp();
  await openHome(app);
  await userEvent.click(await screen.findByRole("button", { name: "Settled (1)" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Unsettle Bump Codex app-server to 0.48" }),
  );
  await waitFor(() => expect(order()[7]).toBe("Bump Codex app-server to 0.48"));
  expect(screen.getByRole("button", { name: "Settled (0)" })).toBeTruthy();

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
  await waitFor(() => expect(order()[7]).toBe("Bump Codex app-server to 0.48"));
  await userEvent.click(
    screen.getByRole("button", { name: "Settle Bump Codex app-server to 0.48" }),
  );
  await waitFor(() => expect(order().slice(0, 7)).not.toContain("Bump Codex app-server to 0.48"));

  // New work on it: the agent starts another turn and the thread is working again.
  app.daemon.apply("thread-bump-codex", [
    { type: "turn.started", agent: "root", nativeTurnId: "follow-up", trigger: "user" },
  ]);
  await waitFor(() => expect(order().slice(0, 7)).toContain("Bump Codex app-server to 0.48"));
  expect(within(card(/Bump Codex/)).getByText("Working")).toBeTruthy();
});

test("the auto-settle rule under Settled is the daemon's setting", async () => {
  const app = workbenchApp();
  await openHome(app);
  await userEvent.click(await screen.findByRole("button", { name: "Settled (1)" }));
  expect(screen.getByText(/Threads that need you never settle/)).toBeTruthy();

  await userEvent.click(await screen.findByRole("button", { name: "When done threads settle" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Never" }));
  expect(await screen.findByText(/Done threads stay until you settle them/)).toBeTruthy();
  expect(app.daemon.services.settings.get("threads.autoSettleAfter")).toBe("never");
});

test("Snooze sinks a thread to the end with its wake time; Undo wakes it", async () => {
  await openHome(workbenchApp());
  await within(threads()).findByRole("link", { name: /Retry budget/ });
  await userEvent.click(
    screen.getByRole("button", { name: "Snooze Retry budget for app-server restarts" }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Tomorrow/ }));

  await waitFor(() => expect(order().at(-1)).toBe("Retry budget for app-server restarts"));
  expect(
    within(card(/Retry budget/)).getByRole("img", { name: /Snoozed until tomorrow/ }),
  ).toBeTruthy();
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() =>
    expect(order().indexOf("Retry budget for app-server restarts")).toBeLessThan(3),
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
