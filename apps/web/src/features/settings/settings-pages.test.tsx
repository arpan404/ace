import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, onTestFinished, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

async function goTo(page: string) {
  await userEvent.click(
    within(screen.getByRole("navigation", { name: "Settings pages" })).getByRole("link", {
      name: page,
    }),
  );
}

async function pick(select: string, option: string) {
  await userEvent.click(await screen.findByRole("combobox", { name: select }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

test("a switched-off General setting stays off after leaving the page and coming back", async () => {
  await harness().open("/settings/general");
  const worktree = await screen.findByRole("switch", { name: "New threads use a worktree" });
  expect(worktree.getAttribute("aria-checked")).toBe("true");
  await userEvent.click(worktree);

  await goTo("Keyboard");
  await screen.findByRole("heading", { level: 2, name: "Keyboard" });
  await goTo("General");
  expect(
    (await screen.findByRole("switch", { name: "New threads use a worktree" })).getAttribute(
      "aria-checked",
    ),
  ).toBe("false");
});

test("follow-ups and restart recovery are stored on the daemon", async () => {
  const app = harness();
  await app.open("/settings/general");
  await pick("Messages sent while the agent works", "Steer");
  await userEvent.click(
    await screen.findByRole("switch", { name: "Continue threads after a restart" }),
  );
  await waitFor(() => {
    expect(app.daemon.services.settings.get("threads.followUpBehavior")).toBe("steer");
    expect(app.daemon.services.settings.get("threads.continueAfterRestart")).toBe(true);
  });

  await goTo("Keyboard");
  await goTo("General");
  expect(
    (await screen.findByRole("combobox", { name: "Messages sent while the agent works" }))
      .textContent,
  ).toContain("Steer");
});

test("when done threads settle is set in General and stored on the daemon", async () => {
  const app = harness();
  await app.open("/settings/general");
  expect(await screen.findByText(/Threads that need you never settle/)).toBeTruthy();
  await pick("Settle done threads", "After a week");
  await waitFor(() =>
    expect(app.daemon.services.settings.get("threads.autoSettleAfter")).toBe("1w"),
  );
  await pick("Settle done threads", "Never");
  await waitFor(() =>
    expect(app.daemon.services.settings.get("threads.autoSettleAfter")).toBe("never"),
  );
});

test("the default provider lists the installed CLIs and remembers the choice", async () => {
  await harness().open("/settings/general");
  const select = await screen.findByRole("combobox", { name: "Default provider for new threads" });
  await waitFor(() => expect(select.textContent).toContain("Claude Code"));
  await userEvent.click(select);
  const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
  // Pi lists models but reports no sign-in state of its own.
  expect(options).toContain("Codex");
  expect(options).toContain("Claude Code");
  expect(options).not.toContain("Antigravity");
  await userEvent.click(screen.getByRole("option", { name: "Codex" }));

  await goTo("Keyboard");
  await goTo("General");
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Default provider for new threads" }).textContent,
    ).toContain("Codex"),
  );
});

test("the unresponsive threshold lives with the other agent settings, and Reset restores it", async () => {
  await harness().open("/settings/general");
  const section = await screen.findByRole("region", { name: "While agents work" });
  expect(within(section).getByText("All devices")).toBeTruthy();
  await pick("Unresponsive after", "15 minutes");
  expect(screen.getByRole("combobox", { name: "Unresponsive after" }).textContent).toContain(
    "15 minutes",
  );

  await goTo("Advanced");
  await userEvent.click(await screen.findByRole("button", { name: "Reset" }));
  const dialog = await screen.findByRole("dialog", { name: "Reset all settings?" });
  expect(
    within(dialog).getByText(/Appearance, themes and this computer's notifications stay/),
  ).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Reset settings" }));
  expect(await screen.findByText("Settings reset")).toBeTruthy();
  await goTo("General");
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Unresponsive after" }).textContent).toContain(
      "5 minutes",
    ),
  );
});

test("a reset the daemon refuses keeps the dialog open and says why", async () => {
  const app = harness();
  await app.open("/settings/advanced");
  app.daemon.failRequests("settings.set");
  await userEvent.click(await screen.findByRole("button", { name: "Reset" }));
  const dialog = await screen.findByRole("dialog", { name: "Reset all settings?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Reset settings" }));
  expect((await within(dialog).findByRole("alert")).textContent).toMatch(/^Couldn't reset/);
  expect(screen.getByRole("dialog", { name: "Reset all settings?" })).toBeTruthy();
});

test("a save the daemon can't take goes back and says so, with Retry", async () => {
  const app = harness();
  await app.open("/settings/general");
  const worktree = await screen.findByRole("switch", { name: "New threads use a worktree" });
  app.daemon.failRequests("settings.set");
  await userEvent.click(worktree);

  expect(
    (await screen.findAllByText('Couldn\'t save "New threads use a worktree"')).length,
  ).toBeGreaterThan(0);
  await waitFor(() => expect(worktree.getAttribute("aria-checked")).toBe("true"));
  app.daemon.restoreRequests();
  // An error toast is announced through Base UI's live region; its card is aria-hidden.
  await userEvent.click(await screen.findByRole("button", { name: "Retry", hidden: true }));
  await waitFor(() => expect(app.daemon.services.settings.get("threads.useWorktree")).toBe(false));
});

test("offline, daemon settings are disabled and say why; this device's stay editable", async () => {
  const app = harness();
  await app.open("/settings/general");
  const worktree = await screen.findByRole("switch", { name: "New threads use a worktree" });
  app.daemon.refuseConnections(true);
  app.daemon.disconnectAll();

  await waitFor(() =>
    expect(
      worktree.getAttribute("aria-disabled") ?? worktree.getAttribute("data-disabled"),
    ).not.toBeNull(),
  );
  // Its wrapper takes focus and gives the reason.
  const wrapper = worktree.parentElement;
  await userEvent.hover(wrapper ?? worktree);
  expect(await screen.findByText("Reconnect to change settings stored on ace")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "Your name" }) as HTMLInputElement).disabled).toBe(
    false,
  );
});

test("searching Settings finds a single setting and opens its page at that row", async () => {
  const scrolled: Element[] = [];
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  onTestFinished(() => {
    Element.prototype.scrollIntoView = scrollIntoView;
  });
  await harness().open("/settings/general");
  await userEvent.type(await screen.findByRole("searchbox", { name: "Search settings" }), "accent");
  const results = screen.getByRole("region", { name: "Matching settings" });
  await userEvent.click(within(results).getByRole("link", { name: /^Accent colour/ }));

  await screen.findByRole("heading", { level: 2, name: "Appearance" });
  const row = document.getElementById("appearance.accent");
  // The page scrolls to that row, the one holding the accent picker.
  await waitFor(() => expect(scrolled).toContain(row));
  expect(screen.getByRole("radiogroup", { name: "Accent colour" })).toBeTruthy();
  const nav = screen.getByRole("navigation", { name: "Settings pages" });
  expect(within(nav).getByRole("link", { name: "Appearance" }).getAttribute("aria-current")).toBe(
    "page",
  );
});

test("the Theme editor is reached from Appearance and keeps Appearance selected in the nav", async () => {
  await harness().open("/settings/appearance");
  await userEvent.click(await screen.findByRole("link", { name: "Open theme editor" }));
  await screen.findByRole("heading", { name: "Theme editor" });
  const nav = screen.getByRole("navigation", { name: "Settings pages" });
  expect(within(nav).getByRole("link", { name: "Appearance" }).getAttribute("aria-current")).toBe(
    "page",
  );
  await userEvent.click(screen.getByRole("link", { name: "Appearance", current: false }));
  await screen.findByRole("heading", { name: "Appearance" });
});

test("⌘K finds a single setting and opens its page at that row", async () => {
  await harness().open("/");
  await screen.findByRole("heading", { level: 1, name: "Home" });
  await userEvent.keyboard("{Control>}k{/Control}");
  const input = await screen.findByRole("combobox", { name: "Search commands" });
  // Not listed until asked for: an empty palette stays short.
  expect(screen.queryByRole("option", { name: /^Accent colour/ })).toBeNull();
  await userEvent.type(input, "accent");
  const option = await screen.findByRole("option", { name: /^Accent colour/ });
  expect(option.textContent).toContain("Appearance");
  await userEvent.keyboard("{Enter}");

  await screen.findByRole("heading", { level: 2, name: "Appearance" });
  expect(document.getElementById("appearance.accent")).toBeTruthy();
});

test("web offers in-app notifications in settings and search while hiding desktop-only controls", async () => {
  await harness().open("/settings/notifications");
  expect(await screen.findByRole("heading", { level: 2, name: "Notifications" })).toBeTruthy();
  const nav = within(screen.getByRole("navigation", { name: "Settings pages" }));
  expect(nav.getByRole("link", { name: "Notifications" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Notifications on this computer" })).toBeNull();
  await userEvent.type(screen.getByRole("searchbox", { name: "Search settings" }), "notifications");
  expect(await nav.findByRole("link", { name: "Notifications" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Notifications on this computer" })).toBeNull();
});
