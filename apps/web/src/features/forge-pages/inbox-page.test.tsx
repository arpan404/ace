import { seedForgeBrowse, workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/** The design's world, with the person's GitHub notifications. */
function withInbox() {
  const app = harness();
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
