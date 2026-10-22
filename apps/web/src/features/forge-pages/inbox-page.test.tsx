import { seedForgeBrowse, workbench } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/** The design's world, with the person's GitHub notifications. */
function withInbox(uiClock?: () => number) {
  const app = harness(uiClock ? { uiClock } : {});
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  seedForgeBrowse(app.daemon, Date.now());
  return app;
}

async function rows() {
  const nav = await screen.findByRole("navigation", { name: "Notifications" });
  return within(nav)
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "");
}
async function row(title: string) {
  const nav = await screen.findByRole("navigation", { name: "Notifications" });
  const found = within(nav)
    .getAllByRole("listitem")
    .find((item) => item.textContent?.includes(title));
  if (!found) throw new Error(`No notification "${title}"`);
  return found;
}

test("the inbox lists unread notifications with why each arrived, and the sidebar counts them", async () => {
  const app = withInbox();
  await app.open("/inbox?project=ace");
  await waitFor(async () => expect(await rows()).toHaveLength(7));
  const first = await row("Reconnect the client worker");
  expect(first.textContent).toContain("#229");
  expect(first.textContent).toContain("Review requested");
  expect((await row("Rewrite the install page")).textContent).toContain("Mentioned");
  expect((await row("CI workflow run failed")).textContent).toContain("CI activity");
  expect(await screen.findByRole("link", { name: "Inbox, 7 unread" })).toBeTruthy();
});

test("opening a pull request from the inbox shows ace's page and marks the notification read", async () => {
  const app = withInbox();
  const user = userEvent.setup();
  await app.open("/inbox?project=ace");
  const link = within(await row("Reconnect the client worker")).getAllByRole("link")[0];
  if (!link) throw new Error("No link");
  await user.click(link);
  expect(
    await screen.findByRole("heading", { name: /Reconnect the client worker after sleep/ }),
  ).toBeTruthy();
  expect(
    app.daemon.workspace.inbox.writes.map(
      (write) => write.type === "forge.inbox.write" && write.input,
    ),
  ).toContainEqual({ action: "read", id: "9001" });
  expect(await screen.findByRole("link", { name: "Inbox, 6 unread" })).toBeTruthy();
});

test("Mark done clears a notification, and Unsubscribe stops one and clears it", async () => {
  const app = withInbox();
  const user = userEvent.setup();
  await app.open("/inbox?project=ace");
  await user.click(
    within(await row("Rewrite the install page")).getByRole("button", { name: "Mark done" }),
  );
  await waitFor(async () =>
    expect((await rows()).some((text) => text.includes("Rewrite the install page"))).toBe(false),
  );
  await user.click(
    within(await row("Roadmap for the native iOS client")).getByRole("button", {
      name: "Unsubscribe",
    }),
  );
  await waitFor(async () =>
    expect((await rows()).some((text) => text.includes("Roadmap for the native"))).toBe(false),
  );
  expect(app.daemon.workspace.inbox.unsubscribedFrom()).toEqual(["9006"]);
});

test("Mark all read in one repository leaves the others unread", async () => {
  const app = withInbox();
  const user = userEvent.setup();
  await app.open("/inbox?project=ace&repo=github.com/acme/docs-site");
  await waitFor(async () => expect(await rows()).toHaveLength(1));
  await user.click(screen.getByRole("button", { name: "Mark all read" }));
  expect(await screen.findByRole("link", { name: "Inbox, 6 unread" })).toBeTruthy();
});

test("with a reason chosen, only those notifications show, read ones included in All", async () => {
  const app = withInbox();
  await app.open("/inbox?project=ace&view=all&reason=team_mention");
  await waitFor(async () => expect(await rows()).toHaveLength(2));
  expect((await rows()).every((text) => text.includes("Team mentioned"))).toBe(true);
});

test("a gh sign-in that can't read notifications says how to fix it", async () => {
  const app = withInbox();
  app.daemon.workspace.inbox.setUnavailable(true);
  await app.open("/inbox?project=ace");
  expect(await screen.findByText("Couldn't load notifications")).toBeTruthy();
  expect(screen.getByText(/gh auth refresh -s notifications/)).toBeTruthy();
});

/** Fails if `regressed` comes true within `ms`: for things that must not happen. */
async function never(regressed: () => boolean | Promise<boolean>, ms = 600) {
  await expect(
    waitFor(async () => expect(await regressed()).toBe(true), { timeout: ms }),
  ).rejects.toThrow();
}
const writesOf = (app: ReturnType<typeof withInbox>) =>
  app.daemon.workspace.inbox.writes.flatMap((write) =>
    write.type === "forge.inbox.write" ? [write.input] : [],
  );
const unreadCount = async () =>
  Number(
    /Inbox, (\d+) unread/.exec(
      (await screen.findByRole("link", { name: /^Inbox/ })).getAttribute("aria-label") ?? "",
    )?.[1] ?? 0,
  );

test("Mark all read covers everything up to the moment of the click, not the last minute's tick", async () => {
  let wall = Date.now();
  const app = withInbox(() => wall);
  const user = userEvent.setup();
  await app.open("/inbox?project=ace");
  await waitFor(async () => expect(await rows()).toHaveLength(7));
  wall += 50_000;
  await user.click(screen.getByRole("button", { name: "Mark all read" }));
  await waitFor(() =>
    expect(writesOf(app)).toContainEqual({
      action: "read-all",
      before: new Date(Math.floor(wall / 1_000) * 1_000).toISOString(),
    }),
  );
});

test("notifications newer than Mark all read stay unread", async () => {
  // The click happens 45 minutes ago: the three newer notifications came after it.
  const app = withInbox(() => Date.now() - 45 * 60_000);
  const user = userEvent.setup();
  await app.open("/inbox?project=ace");
  await waitFor(async () => expect(await rows()).toHaveLength(7));
  await user.click(screen.getByRole("button", { name: "Mark all read" }));
  await waitFor(async () => expect(await unreadCount()).toBe(3));
});

test("rows stay read after Mark all read while GitHub is still applying it", async () => {
  const app = withInbox();
  app.daemon.workspace.inbox.deferReadAll();
  const user = userEvent.setup();
  await app.open("/inbox?project=ace&view=all");
  await waitFor(async () => expect(await rows()).toHaveLength(16));
  await user.click(screen.getByRole("button", { name: "Mark all read" }));
  await waitFor(async () => expect(await unreadCount()).toBe(0));
  await never(async () => (await unreadCount()) > 0);
});

test("with a reason chosen, Mark all read marks only the rows on show", async () => {
  const app = withInbox();
  const user = userEvent.setup();
  await app.open("/inbox?project=ace&view=all&reason=team_mention");
  await waitFor(async () => expect(await rows()).toHaveLength(2));
  await user.click(screen.getByRole("button", { name: "Mark all read" }));
  await waitFor(async () => expect(await unreadCount()).toBe(6));
  expect(writesOf(app)).toEqual([{ action: "read", id: "9006" }]);
});

test("a write GitHub refused puts the row back and says why", async () => {
  const app = withInbox();
  app.daemon.workspace.inbox.setOutcome("refused");
  const user = userEvent.setup();
  await app.open("/inbox?project=ace");
  await user.click(
    within(await row("Rewrite the install page")).getByRole("button", { name: "Mark done" }),
  );
  const alert = await screen.findByRole("alertdialog");
  expect(within(alert).getByText("Couldn't mark it done")).toBeTruthy();
  await waitFor(async () =>
    expect((await rows()).some((text) => text.includes("Rewrite the install page"))).toBe(true),
  );
  expect(await unreadCount()).toBe(7);
});

test("the inbox polls at GitHub's interval while in front, and not while the app is hidden", async () => {
  const app = withInbox();
  const inbox = app.daemon.workspace.inbox;
  inbox.setPollSeconds(1);
  await app.open("/inbox?project=ace");
  await waitFor(async () => expect(await rows()).toHaveLength(7));
  const shown = inbox.reads;
  await waitFor(() => expect(inbox.reads).toBeGreaterThan(shown), { timeout: 3_000 });
  act(() => focusManager.setFocused(false));
  try {
    const hidden = inbox.reads;
    await never(() => inbox.reads > hidden, 2_500);
  } finally {
    act(() => focusManager.setFocused(undefined));
  }
});

test("a refusal that won't pass by itself stops the polling", async () => {
  const app = withInbox();
  const inbox = app.daemon.workspace.inbox;
  inbox.setPollSeconds(1);
  await app.open("/inbox?project=ace");
  await waitFor(async () => expect(await rows()).toHaveLength(7));
  inbox.setUnavailable(true);
  const before = inbox.reads;
  await waitFor(() => expect(inbox.reads).toBeGreaterThan(before), { timeout: 3_000 });
  const refused = inbox.reads;
  await never(() => inbox.reads > refused, 2_500);
});

test("a pull request opened from the inbox goes back to the inbox, by name", async () => {
  const app = withInbox();
  const user = userEvent.setup();
  await app.open("/inbox?project=ace");
  const link = within(await row("Reconnect the client worker")).getAllByRole("link")[0];
  if (!link) throw new Error("No link");
  // The project's own repository opens without naming it.
  expect(link.getAttribute("href")).not.toContain("repo=");
  const other = within(await row("Rewrite the install page")).getAllByRole("link")[0];
  expect(other?.getAttribute("href")).toContain("repo=github.com%2Facme%2Fdocs-site");
  await user.click(link);
  expect(await screen.findByRole("button", { name: "Back to inbox" })).toBeTruthy();
});
