import { workbench, workbenchServices } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

const mention = "mira: @you Which port does the daemon default to in docker?";

async function openActivity(path = "/activity") {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open(path);
  const sidebar = await screen.findByRole("complementary", { name: "Activity" });
  const list = await within(sidebar).findByRole("list", { name: "Activity" });
  const feed = within(list);
  await feed.findByText("Checks failed on #74");
  return { app, sidebar, feed };
}

const main = () => within(screen.getByRole("main"));
const rowOf = (feed: ReturnType<typeof within>, text: string) => {
  const row = feed.getByText(text).closest("button");
  if (!row) throw new Error(`No row for ${text}`);
  return row;
};

test("choosing a mention shows the whole comment in Activity instead of leaving it", async () => {
  const { feed } = await openActivity();
  await userEvent.click(feed.getByText(mention));

  const detail = await main().findByRole("article", { name: "mira mentioned you" });
  expect(
    within(detail).getByText(/Which port does the daemon default to in docker\?/),
  ).toBeTruthy();
  expect(within(detail).getByRole("button", { name: /Open thread/ })).toBeTruthy();
  // Still Activity, and the row is read now.
  expect(screen.getByRole("heading", { level: 1, name: "Activity" })).toBeTruthy();
  expect(within(rowOf(feed, mention)).queryByText("Unread")).toBeNull();
  expect(rowOf(feed, mention).getAttribute("aria-current")).toBe("page");
});

test("a review comment that mentions you is answered from its page, on the pull request", async () => {
  const { app, feed } = await openActivity();
  await userEvent.click(feed.getByText(mention));
  const detail = await main().findByRole("article", { name: "mira mentioned you" });
  await userEvent.type(
    within(detail).getByRole("textbox", { name: "Reply to mira" }),
    "Port 4390, unless ACE_PORT says otherwise{Enter}",
  );
  expect(await screen.findByText("Replied to mira")).toBeTruthy();
  const reply = await app.client.request({
    type: "workspace.request",
    operation: { op: "pr.status", threadId: ThreadId.parse("thread-install-page") },
  });
  const status = reply.result.kind === "pr" ? reply.result.status : null;
  expect(status?.comments).toContainEqual(
    expect.objectContaining({ body: "Port 4390, unless ACE_PORT says otherwise", replyTo: 1 }),
  );
});

test("a CI failure and an automation run each have their own page", async () => {
  const { feed } = await openActivity();
  await userEvent.click(feed.getByText("Checks failed on #74"));
  const checks = await main().findByRole("list", { name: "Failing checks" });
  expect(within(checks).getAllByRole("listitem").length).toBeGreaterThan(0);

  await userEvent.click(screen.getByRole("tab", { name: "Runs" }));
  await userEvent.click(feed.getByTitle("Failed: npm registry timeout, retried once"));
  const run = await main().findByRole("article", { name: "Nightly dependency audit" });
  expect(within(run).getByRole("region", { name: "Run error" }).textContent).toContain(
    "npm registry timeout, retried once",
  );
  expect(within(run).getByText("Took")).toBeTruthy();
  expect(within(run).getByRole("link", { name: /Open automation/ })).toBeTruthy();
});

test("a link to an item opens it on its own", async () => {
  await openActivity(`/activity?item=${encodeURIComponent("run:run-flaky-1")}`);
  expect(await main().findByRole("article", { name: "Flaky test triage" })).toBeTruthy();
  expect(main().getByText("Nothing flaky across 3 runs")).toBeTruthy();
});

test("every tab selects its first item and clears the previous tab's detail", async () => {
  const { sidebar, feed } = await openActivity();
  expect((await main().findAllByRole("article"))[0]?.getAttribute("aria-current")).toBe("true");
  await userEvent.click(within(sidebar).getByRole("tab", { name: "Mentions" }));
  expect(await main().findByRole("article", { name: "mira mentioned you" })).toBeTruthy();
  await userEvent.click(within(sidebar).getByRole("tab", { name: "Runs" }));
  await waitFor(() =>
    expect(feed.getAllByRole("button")[0]?.getAttribute("aria-current")).toBe("page"),
  );
  expect(main().getAllByRole("article")).toHaveLength(1);
  await userEvent.click(within(sidebar).getByRole("tab", { name: /Needs you/ }));
  await waitFor(() =>
    expect(main().getAllByRole("article")[0]?.getAttribute("aria-current")).toBe("true"),
  );
  expect(main().queryByRole("article", { name: "mira mentioned you" })).toBeNull();
});

test("read marks go to the daemon, and another device's marks arrive at once", async () => {
  const { app, feed } = await openActivity();
  await userEvent.click(feed.getByText("Checks failed on #74"));
  await waitFor(() =>
    expect(app.daemon.services.activityReads.get().read.map((item) => item.id)).toContainEqual(
      expect.stringMatching(/^ci:/),
    ),
  );
  // Another device marks everything read: this one follows at once.
  const cursor = app.daemon.services.activityReads.get();
  app.daemon.services.activityReads.set({ ...cursor, before: Date.now() + 60_000, read: [] });
  await waitFor(() => expect(feed.queryAllByText("Unread")).toHaveLength(0));
});

test("a fresh open honours what the daemon already counts as read", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now()));
  app.daemon.services.activityReads.set({
    before: Date.now() + 60_000,
    read: [],
    unread: [],
    revision: 3,
  });
  await app.open("/activity");
  const sidebar = await screen.findByRole("complementary", { name: "Activity" });
  const feed = await within(sidebar).findByRole("list", { name: "Activity" });
  await within(feed).findByText("Checks failed on #74");
  expect(within(feed).queryAllByText("Unread")).toHaveLength(0);
});

test("Mark all read is scoped to the tab, and Undo brings the marks back", async () => {
  const { sidebar, feed } = await openActivity();
  await userEvent.click(within(sidebar).getByRole("tab", { name: "Runs" }));
  await userEvent.click(within(sidebar).getByRole("button", { name: "Mark all read" }));
  await waitFor(() => expect(feed.queryAllByText("Unread")).toHaveLength(0));
  const toasts = within(screen.getByRole("region", { name: "Notifications" }));
  expect(await toasts.findByText(/^Marked \d+ read$/)).toBeTruthy();

  await userEvent.click(within(sidebar).getByRole("tab", { name: "All" }));
  // CI isn't a run: still unread.
  expect(within(rowOf(feed, "Checks failed on #74")).getByText("Unread")).toBeTruthy();

  await userEvent.click(toasts.getByRole("button", { name: "Undo" }));
  await waitFor(() =>
    expect(within(rowOf(feed, "Flaky test triage")).getByText("Unread")).toBeTruthy(),
  );
});

test("a row's menu marks it unread again", async () => {
  const { feed } = await openActivity();
  await userEvent.click(feed.getByText("Checks failed on #74"));
  await waitFor(() =>
    expect(within(rowOf(feed, "Checks failed on #74")).queryByText("Unread")).toBeNull(),
  );
  await userEvent.pointer({ keys: "[MouseRight]", target: rowOf(feed, "Checks failed on #74") });
  await userEvent.click(await screen.findByRole("menuitem", { name: /Mark unread/ }));
  expect(within(rowOf(feed, "Checks failed on #74")).getByText("Unread")).toBeTruthy();
});

test("the feed is one Tab stop: arrows and J/K move along it, Enter opens a row", async () => {
  const { feed } = await openActivity();
  const first = feed.getAllByRole("button").find((row) => row.tabIndex === 0);
  expect(
    feed
      .getAllByRole("button")
      .filter((row) => row.hasAttribute("data-view-row") && row.tabIndex === 0),
  ).toHaveLength(1);
  first?.focus();
  await userEvent.keyboard("{End}");
  const last = document.activeElement;
  await userEvent.keyboard("k");
  expect(document.activeElement).not.toBe(last);
  await userEvent.keyboard("j");
  expect(document.activeElement).toBe(last);

  rowOf(feed, mention).focus();
  await userEvent.keyboard("{Enter}");
  expect(await main().findByRole("article", { name: "mira mentioned you" })).toBeTruthy();

  // Esc from the main column comes back to the list, on the chosen row.
  main()
    .getByRole("button", { name: /Open thread/ })
    .focus();
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(rowOf(feed, mention));
});

test("J moves focus itself to the next card, so its title is read out", async () => {
  await openActivity();
  const cards = await main().findAllByRole("article");
  await waitFor(() => expect(cards[0]?.getAttribute("aria-current")).toBe("true"));
  await userEvent.keyboard("j");
  const second = main().getAllByRole("article")[1];
  expect(document.activeElement).toBe(second);
  expect(second?.getAttribute("aria-current")).toBe("true");
});

test("the filter tabs are one Tab stop that the arrow keys move along", async () => {
  const { sidebar } = await openActivity();
  const all = within(sidebar).getByRole("tab", { name: "All" });
  expect(all.tabIndex).toBe(0);
  expect(within(sidebar).getByRole("tab", { name: "Runs" }).tabIndex).toBe(-1);
  all.focus();
  await userEvent.keyboard("{ArrowLeft}");
  const runs = within(sidebar).getByRole("tab", { name: "Runs" });
  expect(document.activeElement).toBe(runs);
  expect(runs.getAttribute("aria-selected")).toBe("true");
  expect(within(sidebar).getByRole("tabpanel", { name: "Runs" })).toBeTruthy();
});

test("filtering by project counts that project and shows a chip that clears it", async () => {
  const { sidebar } = await openActivity();
  const header = within(screen.getByRole("banner"));
  expect(header.getByText("3 need you")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Filter" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "billing-api" }));
  // The menu closes on a choice.
  await waitFor(() => expect(screen.queryByRole("menuitemradio")).toBeNull());
  expect(await header.findByText("1 needs you · billing-api")).toBeTruthy();
  expect(
    within(within(sidebar).getByRole("tab", { name: /Needs you/ })).getByText("1"),
  ).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Clear the billing-api filter" }));
  expect(await header.findByText("3 need you")).toBeTruthy();
});

const requests = ["Allow a force push", "How should the sheet", "Install @fontsource"];
const order = (titles: string[]) =>
  titles.filter((title) => requests.some((request) => title.includes(request)));

test("what needs you is listed oldest first, the same in the sidebar and the cards", async () => {
  const { feed } = await openActivity();
  // Sidebar, each thread's cards and the waiting-since reporters arrive separately.
  // Read both columns again until they show all requests in the fixture's time order.
  await waitFor(() => {
    const cards = main().getAllByRole("article");
    expect(cards).toHaveLength(3);
    const titles = cards.map((card) => card.getAttribute("aria-label") ?? "");
    const rows = feed.getAllByRole("button").map((row) => row.textContent ?? "");
    const expected = requests.map((request) => request.slice(0, 12));
    expect(order(titles).map((title) => title.slice(0, 12))).toEqual(expected);
    expect(order(rows).map((row) => row.slice(0, 12))).toEqual(expected);
  });
  // The rest of the feed sits under day headings.
  expect(feed.getByRole("heading", { level: 3, name: "Today" })).toBeTruthy();
});

test("H snoozes the focused card's thread, which leaves Needs you", async () => {
  await openActivity();
  const cards = await main().findAllByRole("article");
  const first = cards[0];
  if (!first) throw new Error("no cards");
  const title = first.getAttribute("aria-label") ?? "";
  await waitFor(() => expect(first.getAttribute("aria-current")).toBe("true"));
  await userEvent.keyboard("h");
  await userEvent.click(await screen.findByRole("menuitem", { name: /1 hour/ }));
  await waitFor(() => expect(main().queryByRole("article", { name: title })).toBeNull());
});

test("X picks the focused card, and the picked threads snooze together", async () => {
  await openActivity();
  const cards = await main().findAllByRole("article");
  const first = cards[0] as HTMLElement;
  const title = first.getAttribute("aria-label") ?? "";
  await waitFor(() => expect(first.getAttribute("aria-current")).toBe("true"));
  await userEvent.keyboard("x");
  expect(within(first).getByText("Picked")).toBeTruthy();
  const bar = within(screen.getByRole("toolbar", { name: "Picked items" }));
  expect(bar.getByText("1 picked")).toBeTruthy();
  // No batch approval, ever.
  expect(bar.queryByRole("button", { name: /Approve/ })).toBeNull();
  await userEvent.click(bar.getByRole("button", { name: "Snooze" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "1 hour" }));
  await waitFor(() => expect(main().queryByRole("article", { name: title })).toBeNull());
  expect(screen.queryByRole("toolbar", { name: "Picked items" })).toBeNull();
});

test("Shift-clicking feed rows picks them, and the picked ones are marked read together", async () => {
  const { feed } = await openActivity();
  const user = userEvent.setup();
  await user.keyboard("{Shift>}");
  await user.click(rowOf(feed, "Checks failed on #74"));
  await user.click(rowOf(feed, mention));
  await user.keyboard("{/Shift}");
  const bar = within(screen.getByRole("toolbar", { name: "Picked items" }));
  expect(bar.getByText("2 picked")).toBeTruthy();
  await userEvent.click(bar.getByRole("button", { name: "Mark read" }));
  await waitFor(() => expect(within(rowOf(feed, mention)).queryByText("Unread")).toBeNull());
  expect(within(rowOf(feed, "Checks failed on #74")).queryByText("Unread")).toBeNull();
});

test("the first run says it once: one line in the list, one state in the main column", async () => {
  const app = harness();
  await app.open("/activity");
  const sidebar = await screen.findByRole("complementary", { name: "Activity" });
  expect(await within(sidebar).findByText("No activity yet")).toBeTruthy();
  expect(await main().findByText("You're all caught up")).toBeTruthy();
  expect(within(sidebar).queryByText("You're all caught up")).toBeNull();
});

test("the list never says it's empty before the runs arrive", async () => {
  const app = harness();
  app.daemon.holdRequests("automation.inbox");
  await app.open("/activity");
  const sidebar = await screen.findByRole("complementary", { name: "Activity" });
  expect(await within(sidebar).findByRole("status", { name: "Loading activity" })).toBeTruthy();
  expect(within(sidebar).queryByText("No activity yet")).toBeNull();
});

test("a mark the daemon couldn't take is kept and sent with the next one", async () => {
  const { app, feed } = await openActivity();
  app.daemon.failRequests("activity.markRead");
  await userEvent.click(feed.getByText("Checks failed on #74"));
  // Still shown as read here, and not given up on.
  await waitFor(() =>
    expect(within(rowOf(feed, "Checks failed on #74")).queryByText("Unread")).toBeNull(),
  );
  app.daemon.restoreRequests();
  await userEvent.click(screen.getByRole("tab", { name: "Runs" }));
  await userEvent.click(feed.getByText("Flaky test triage"));
  await waitFor(() => {
    const read = app.daemon.services.activityReads.get().read.map((entry) => entry.id);
    expect(read).toContain("run-flaky-1");
    expect(read.some((id) => id.startsWith("ci:"))).toBe(true);
  });
});

test("a device that may not change read marks says so, and marks still apply here", async () => {
  const { app, feed } = await openActivity();
  app.daemon.refuseRequests("forbidden", "activity.markRead");
  await userEvent.click(feed.getByText("Checks failed on #74"));
  expect(await screen.findByText(/This device can't change read marks/)).toBeTruthy();
  expect(within(rowOf(feed, "Checks failed on #74")).queryByText("Unread")).toBeNull();
});

test("a daemon without the read cursor keeps marks for this session, quietly", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now()));
  app.daemon.refuseRequests("activity_unavailable", "activity.reads", "activity.markRead");
  await app.open("/activity");
  const sidebar = await screen.findByRole("complementary", { name: "Activity" });
  const feed = within(await within(sidebar).findByRole("list", { name: "Activity" }));
  await feed.findByText("Checks failed on #74");
  expect(screen.queryByText(/This device can't change read marks/)).toBeNull();
});

test("a link to a request that's no longer open says so instead of loading", async () => {
  await openActivity(
    `/activity?item=${encodeURIComponent("interaction:thread-retry-budget:not-a-request")}`,
  );
  expect(await main().findByText("This request is no longer open")).toBeTruthy();
});

test("a link to an event the feed doesn't have says it's gone once the feed has loaded", async () => {
  await openActivity(`/activity?item=${encodeURIComponent("event:mention:gone:issue:1")}`);
  expect(await main().findByText("This item is no longer in Activity")).toBeTruthy();
});

test("a run that can't be read offers to try again", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now()));
  app.daemon.failRequests("automation.inbox");
  await app.open(`/activity?item=${encodeURIComponent("run:run-flaky-1")}`);
  await screen.findByRole("main");
  expect(await main().findByText("Couldn't load this item", {}, { timeout: 4000 })).toBeTruthy();
  app.daemon.restoreRequests();
  await userEvent.click(main().getByRole("button", { name: "Try again" }));
  expect(await main().findByRole("article", { name: "Flaky test triage" })).toBeTruthy();
});

test("a rebound Next key moves between cards", async () => {
  const { app } = await openActivity();
  await app.client.request({
    type: "settings.set",
    key: "clients.keybindings",
    value: { "activity.next": "n" },
    layer: { kind: "global" },
  });
  const cards = await main().findAllByRole("article");
  await waitFor(() => expect(cards[0]?.getAttribute("aria-current")).toBe("true"));
  await waitFor(async () => {
    await userEvent.keyboard("n");
    expect(main().getAllByRole("article")[1]?.getAttribute("aria-current")).toBe("true");
  });
});

test("All opens the first run when nothing needs you, and empty tabs clear that detail", async () => {
  const app = harness();
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open("/activity");
  await screen.findByRole("main");
  expect(await main().findByRole("article", { name: "Review pull requests on open" })).toBeTruthy();
  const sidebar = within(screen.getByRole("complementary", { name: "Activity" }));
  await userEvent.click(sidebar.getByRole("tab", { name: "Mentions" }));
  expect(await main().findByText("No mentions")).toBeTruthy();
  expect(main().queryByRole("article")).toBeNull();
  await userEvent.click(sidebar.getByRole("tab", { name: /Needs you/ }));
  expect(await main().findByText("You're all caught up")).toBeTruthy();
});

test("Activity run output links to the produced thread", async () => {
  await openActivity(`/activity?item=${encodeURIComponent("run:run-review-212")}`);
  const run = await main().findByRole("article", { name: "Review pull requests on open" });
  expect(within(run).getByRole("region", { name: "Run output" }).textContent).toContain(
    "#212 · approved with 1 note",
  );
  await userEvent.click(within(run).getByRole("link", { name: /Open thread/ }));
  expect(
    await screen.findByRole("heading", { level: 1, name: "Bump Codex app-server to 0.48" }),
  ).toBeTruthy();
});
