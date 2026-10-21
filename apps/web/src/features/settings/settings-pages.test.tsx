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

/** Press one segment of a segmented control. */
async function press(control: string, option: string) {
  const group = await screen.findByRole("group", { name: control });
  await userEvent.click(within(group).getByRole("button", { name: option }));
}

/** The pressed segment of a segmented control. */
async function pressed(control: string) {
  const group = await screen.findByRole("group", { name: control });
  return within(group)
    .getAllByRole("button")
    .find((button) => button.getAttribute("aria-pressed") === "true")?.textContent;
}

async function pick(select: string, option: string) {
  await userEvent.click(await screen.findByRole("combobox", { name: select }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

test("a switched-off agent setting stays off after leaving the page and coming back", async () => {
  await harness().open("/settings/agents");
  const worktree = await screen.findByRole("switch", { name: "New threads use a worktree" });
  expect(worktree.getAttribute("aria-checked")).toBe("true");
  await userEvent.click(worktree);

  await goTo("Keyboard");
  await screen.findByRole("heading", { level: 2, name: "Keyboard" });
  await goTo("Agents");
  expect(
    (await screen.findByRole("switch", { name: "New threads use a worktree" })).getAttribute(
      "aria-checked",
    ),
  ).toBe("false");
});

test("the switch preservation setting persists after leaving Agents", async () => {
  const app = harness();
  await app.open("/settings/agents");
  const toggle = await screen.findByRole("switch", { name: "Fork when switching providers" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await userEvent.click(toggle);
  await waitFor(() => expect(app.daemon.services.settings.get("threads.forkOnSwitch")).toBe(true));
  await goTo("Keyboard");
  await goTo("Agents");
  expect(
    (await screen.findByRole("switch", { name: "Fork when switching providers" })).getAttribute(
      "aria-checked",
    ),
  ).toBe("true");
}, 30_000);

test("follow-ups are stored on the daemon and nothing offers to continue work after a restart", async () => {
  const app = harness();
  await app.open("/settings/agents");
  await press("Messages sent while the agent works", "Steer");
  expect(screen.queryByRole("switch", { name: /after a restart/i })).toBeNull();
  await waitFor(() => {
    expect(app.daemon.services.settings.get("threads.followUpBehavior")).toBe("steer");
  });

  await goTo("Keyboard");
  await goTo("Agents");
  expect(await pressed("Messages sent while the agent works")).toBe("Steer");
});

test("when done threads settle is set in Agents and stored on the daemon", async () => {
  const app = harness();
  await app.open("/settings/agents");
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
  await harness().open("/settings/agents");
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
  await goTo("Agents");
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Default provider for new threads" }).textContent,
    ).toContain("Codex"),
  );
});

test("Reset restores the follow-up behavior on every device", async () => {
  await harness().open("/settings/agents");
  const section = await screen.findByRole("region", { name: "While agents work" });
  expect(within(section).queryByText("All devices")).toBeNull();
  await press("Messages sent while the agent works", "Steer");
  expect(await pressed("Messages sent while the agent works")).toBe("Steer");

  await goTo("Advanced");
  await userEvent.click(await screen.findByRole("button", { name: "Reset" }));
  const dialog = await screen.findByRole("dialog", { name: "Reset all settings?" });
  expect(within(dialog).getByText(/Appearance, themes and notifications stay/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Reset settings" }));
  expect(await screen.findByText("Settings reset")).toBeTruthy();
  await goTo("Agents");
  await waitFor(async () =>
    expect(await pressed("Messages sent while the agent works")).toBe("Queue"),
  );
});

test("a reset the daemon refuses keeps the dialog open and says why", async () => {
  const app = harness();
  await app.open("/settings/advanced");
  app.daemon.failRequests("settings.reset");
  await userEvent.click(await screen.findByRole("button", { name: "Reset" }));
  const dialog = await screen.findByRole("dialog", { name: "Reset all settings?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Reset settings" }));
  expect((await within(dialog).findByRole("alert")).textContent).toMatch(/^Couldn't reset/);
  expect(screen.getByRole("dialog", { name: "Reset all settings?" })).toBeTruthy();
});

test("a save the daemon can't take goes back and says so, with Retry", async () => {
  const app = harness();
  await app.open("/settings/agents");
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
  await app.open("/settings/agents");
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
  await goTo("General");
  expect(
    ((await screen.findByRole("textbox", { name: "Your name" })) as HTMLInputElement).disabled,
  ).toBe(false);
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
  await userEvent.type(await screen.findByRole("searchbox", { name: "Search settings" }), "glass");
  const results = screen.getByRole("region", { name: "Matching settings" });
  await userEvent.click(within(results).getByRole("link", { name: /^Translucency/ }));

  await screen.findByRole("heading", { level: 2, name: "Appearance" });
  const row = document.getElementById("appearance.translucency");
  // The page scrolls to that row, the one holding the Translucency slider.
  await waitFor(() => expect(scrolled).toContain(row));
  expect(screen.getByRole("slider", { name: "Translucency" })).toBeTruthy();
  const nav = screen.getByRole("navigation", { name: "Settings pages" });
  expect(within(nav).getByRole("link", { name: "Appearance" }).getAttribute("aria-current")).toBe(
    "page",
  );
});

test("⌘K finds a single setting and opens its page at that row", async () => {
  await harness().open("/");
  await screen.findByRole("heading", { level: 1, name: "Home" });
  await userEvent.keyboard("{Control>}k{/Control}");
  const input = await screen.findByRole("combobox", { name: "Search commands" });
  // Not listed until asked for: an empty palette stays short.
  expect(screen.queryByRole("option", { name: /^Reduce motion/ })).toBeNull();
  await userEvent.type(input, "reduce motion");
  const option = await screen.findByRole("option", { name: /^Reduce motion/ });
  expect(option.textContent).toContain("Appearance");
  await userEvent.keyboard("{Enter}");

  await screen.findByRole("heading", { level: 2, name: "Appearance" });
  expect(document.getElementById("appearance.reduceMotion")).toBeTruthy();
});

test("web offers in-app notifications in settings and search while hiding desktop-only controls", async () => {
  await harness().open("/settings/notifications");
  expect(await screen.findByRole("heading", { level: 2, name: "Notifications" })).toBeTruthy();
  const nav = within(screen.getByRole("navigation", { name: "Settings pages" }));
  expect(nav.getByRole("link", { name: "Notifications" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Desktop notifications" })).toBeNull();
  await userEvent.type(screen.getByRole("searchbox", { name: "Search settings" }), "notifications");
  expect(await nav.findByRole("link", { name: "Notifications" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Desktop notifications" })).toBeNull();
});
