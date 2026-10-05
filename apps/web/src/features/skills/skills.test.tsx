import { workbenchServices } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const catalog = () => screen.getByRole("navigation", { name: "Skills catalog" });

afterEach(() => localStorage.clear());

/** The design's daemon: two plugins installed, and a third its marketplace offers. */
async function open(path: string) {
  const app = harness();
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open(path);
  return app;
}

/** What the daemon itself says about its plugins: installs, pending reviews, availability. */
async function pluginList(app: ReturnType<typeof harness>) {
  const reply = await app.client.request({
    type: "pluginRequest",
    request: { type: "plugins.list" },
  });
  if (reply.response.type !== "plugins.list") throw new Error("Expected a plugin list");
  return reply.response;
}

/** The plugins the daemon has installed, asked of it directly. */
async function installed(app: ReturnType<typeof harness>): Promise<string[]> {
  const reply = await app.client.request({
    type: "pluginRequest",
    request: { type: "plugins.list" },
  });
  return reply.response.type === "plugins.list"
    ? reply.response.installs.map((install) => install.name)
    : [];
}

test("Skills opens on the first skill with its source from the plugin", async () => {
  await open("/skills");

  expect(await screen.findByRole("heading", { level: 1, name: "code-review" })).toBeTruthy();
  expect(screen.getByText("skills/code-review/SKILL.md")).toBeTruthy();
  expect(await screen.findByText(/Review the changes since a fixed point/)).toBeTruthy();
  const sections = within(catalog())
    .getAllByRole("region")
    .map((region) => region.getAttribute("aria-label"));
  expect(sections).toEqual(["Skills", "Slash commands", "Agents", "Plugins"]);
});

test("searching matches the plugin a skill ships with, and a miss offers to clear the search", async () => {
  await open("/skills");
  await screen.findByRole("navigation", { name: "Skills catalog" });
  const search = screen.getByRole("searchbox", { name: "Search skills" });

  await userEvent.type(search, "PR");
  await waitFor(() => expect(within(catalog()).queryByText("tdd")).toBeNull());
  expect(within(catalog()).getByText("pr-desc")).toBeTruthy();

  await userEvent.clear(search);
  await userEvent.type(search, "engineering");
  await waitFor(() => expect(within(catalog()).getByText("tdd")).toBeTruthy());
  expect(within(catalog()).queryByText("release-notes")).toBeNull();

  await userEvent.clear(search);
  await userEvent.type(search, "zzzz");
  expect(await screen.findByText('Nothing matches "zzzz".')).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(within(catalog()).getByText("release-notes")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Plugin: All plugins" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "release" }));
  await waitFor(() => expect(within(catalog()).queryByText("code-review")).toBeNull());
  expect(within(catalog()).getByText("standup")).toBeTruthy();
});

test("arrow keys move through the catalog as one Tab stop", async () => {
  await open("/skills");
  await screen.findByRole("heading", { level: 1, name: "code-review" });
  const first = within(catalog()).getByRole("link", { name: /^code-review/ });
  first.focus();

  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement?.textContent).toMatch(/^tdd/);
  await userEvent.keyboard("{End}");
  expect(document.activeElement?.textContent).toMatch(/^release/);
});

test("a skill's page turns its plugin on only through a control that names the plugin", async () => {
  await open("/skills/release~skill~release-notes");
  await screen.findByRole("heading", { level: 1, name: "release-notes" });
  const row = within(catalog()).getByRole("link", { name: /release-notes/ });
  expect(row.textContent).toContain("Off");
  expect(screen.getByText("Off · release is off")).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Enabled" })).toBeNull();

  await userEvent.click(screen.getByRole("switch", { name: "Turn release on or off" }));

  await waitFor(() => expect(row.textContent).not.toContain("Off"));
  expect(within(catalog()).getByRole("link", { name: /standup/ }).textContent).not.toContain("Off");
  expect(await screen.findByText("release turned on")).toBeTruthy();
});

test("a plugin's page lists what it ships and its pin, with the switch labelled", async () => {
  await open("/skills/plugin~engineering");
  await screen.findByRole("heading", { level: 1, name: "engineering" });

  expect(screen.getByRole("switch", { name: "Enabled" })).toBeTruthy();
  expect(screen.getByText(/^Version 2\.3\.0 · pinned b{12} · installed /)).toBeTruthy();
  const contents = within(screen.getByRole("region", { name: "Contents" }));
  for (const name of ["code-review", "tdd", "diagnosing-bugs", "pr-desc", "reviewer"])
    expect(contents.getByRole("link", { name: new RegExp(`^${name}`) })).toBeTruthy();

  await userEvent.click(contents.getByRole("link", { name: /^reviewer/ }));
  expect(await screen.findByRole("heading", { level: 1, name: "reviewer" })).toBeTruthy();
});

test("ticking providers is one change and one toast, sent when the menu closes", async () => {
  const app = await open("/skills/plugin~release");
  await screen.findByRole("heading", { level: 1, name: "release" });
  expect(screen.getByText("Claude Code only")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Change" }));
  await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Codex" }));
  await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Cursor" }));
  await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Cursor" }));
  // Nothing is sent while the menu is open.
  expect(screen.getByText("Claude Code only")).toBeTruthy();
  await userEvent.keyboard("{Escape}");

  expect(await screen.findByText("Claude Code and Codex")).toBeTruthy();
  expect(await screen.findByText("release available to Claude Code and Codex")).toBeTruthy();
  expect(screen.getAllByText(/^release available to/)).toHaveLength(1);
  // The daemon got exactly the closed menu's choice.
  const { availability } = await pluginList(app);
  expect(availability?.find((entry) => entry.name === "release")?.providers).toEqual([
    "claude",
    "codex",
  ]);
});

test("installing lists the marketplace, shows what a plugin runs, and Back keeps the form", async () => {
  await open("/skills");
  await screen.findByRole("heading", { level: 1, name: "code-review" });

  await userEvent.click(screen.getByRole("button", { name: "Install plugin" }));
  const dialog = await screen.findByRole("dialog", { name: "Install a plugin" });
  await userEvent.type(within(dialog).getByLabelText("Repository"), "not a repo");
  await userEvent.click(within(dialog).getByRole("button", { name: "Find plugins" }));
  expect(within(dialog).getByRole("alert").textContent).toContain("owner/name");

  await userEvent.clear(within(dialog).getByLabelText("Repository"));
  await userEvent.type(within(dialog).getByLabelText("Repository"), "getsentry/sentry");
  await userEvent.click(within(dialog).getByRole("button", { name: "Find plugins" }));
  const listing = await within(dialog).findByRole("radiogroup", {
    name: "Plugins in this marketplace",
  });
  // The only plugin on offer is picked already.
  expect(within(listing).getByRole("radio", { name: /sentry/ })).toHaveProperty("checked", true);
  expect(within(listing).getByText("1 skill")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));

  let review = await screen.findByRole("dialog", { name: "Review sentry 0.9.0" });
  expect(within(review).getByText(/From getsentry\/sentry, pinned/)).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement).toBe(within(review).getByRole("button", { name: "Install" })),
  );
  await userEvent.click(within(review).getByRole("button", { name: "Back" }));
  const again = await screen.findByRole("dialog", { name: "Install a plugin" });
  expect(within(again).getByLabelText<HTMLInputElement>("Repository").value).toBe(
    "getsentry/sentry",
  );
  expect(within(again).getByRole("radio", { name: /sentry/ })).toHaveProperty("checked", true);
  await userEvent.click(within(again).getByRole("button", { name: "Review" }));

  review = await screen.findByRole("dialog", { name: "Review sentry 0.9.0" });
  const runs = within(within(review).getByRole("list", { name: "What it runs" }));
  expect(runs.getByText("MCP server sentry")).toBeTruthy();
  expect(runs.getByText("npx -y @sentry/mcp-server@0.9.0")).toBeTruthy();
  await userEvent.click(within(review).getByRole("button", { name: "Install" }));

  expect(await screen.findByRole("heading", { level: 1, name: "sentry" })).toBeTruthy();
  expect(await screen.findByText("From getsentry/sentry")).toBeTruthy();
  const plugins = within(catalog()).getByRole("region", { name: "Plugins" });
  expect(await within(plugins).findByText("sentry")).toBeTruthy();
  expect(within(catalog()).getByText("triage-issue")).toBeTruthy();
});

test("the install form can be cancelled, and closing a review installs nothing", async () => {
  await open("/skills");
  await screen.findByRole("heading", { level: 1, name: "code-review" });
  await userEvent.click(screen.getByRole("button", { name: "Install plugin" }));
  let dialog = await screen.findByRole("dialog", { name: "Install a plugin" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  await userEvent.click(screen.getByRole("button", { name: "Install plugin" }));
  dialog = await screen.findByRole("dialog", { name: "Install a plugin" });
  await userEvent.type(within(dialog).getByLabelText("Repository"), "getsentry/sentry");
  await userEvent.click(within(dialog).getByRole("button", { name: "Find plugins" }));
  await userEvent.click(await within(dialog).findByRole("button", { name: "Review" }));
  const review = await screen.findByRole("dialog", { name: "Review sentry 0.9.0" });
  await userEvent.click(within(review).getByRole("button", { name: "Close" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(within(catalog()).queryByText("sentry")).toBeNull();
});

test("Update re-reads the plugin and says when nothing changed", async () => {
  await open("/skills/plugin~engineering");
  await screen.findByRole("heading", { level: 1, name: "engineering" });

  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Update…" }));

  expect(await screen.findByText("engineering is up to date")).toBeTruthy();
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Update engineering" })).toBeNull(),
  );
});

test("removing a plugin from a skill's page asks first, names the plugin and can be undone", async () => {
  const app = await open("/skills/engineering~skill~tdd");
  await screen.findByRole("heading", { level: 1, name: "tdd" });
  const more = screen.getByRole("button", { name: "More actions" });

  await userEvent.click(more);
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "Remove plugin engineering…" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Remove engineering?" });
  expect(
    within(dialog).getByText(
      "Its 3 skills, 1 command and 1 agent stop loading for every provider. Installing it again needs a new review.",
    ),
  ).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })),
  );
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(more));
  expect(await installed(app)).toContain("engineering");

  await userEvent.click(more);
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "Remove plugin engineering…" }),
  );
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Remove engineering?" })).getByRole("button", {
      name: "Remove plugin",
    }),
  );
  await waitFor(() => expect(within(catalog()).queryByText("tdd")).toBeNull());
  // Still installed on the daemon while Undo is offered.
  expect(await installed(app)).toContain("engineering");

  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(await within(catalog()).findByText("tdd")).toBeTruthy();
  expect(await installed(app)).toContain("engineering");
});

test("a removal reaches the daemon once its Undo has gone", async () => {
  const app = await open("/skills/plugin~release");
  await screen.findByRole("heading", { level: 1, name: "release" });

  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Remove release…" }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Remove release?" })).getByRole("button", {
      name: "Remove plugin",
    }),
  );
  await waitFor(() => expect(within(catalog()).queryByText("release-notes")).toBeNull());
  expect(await installed(app)).toContain("release");

  await userEvent.hover(await screen.findByText("Removed release"));
  await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
  await waitFor(async () => expect(await installed(app)).not.toContain("release"));
  expect(within(catalog()).getByText("code-review")).toBeTruthy();
  expect(within(catalog()).queryByText("release-notes")).toBeNull();
});

test("a removal confirmed before a reload is finished when Skills next connects", async () => {
  // As if the window closed during Undo: the pending removal is on this device, overdue.
  localStorage.setItem(
    "ace.skills.removing",
    JSON.stringify([{ daemon: "memory://fake-daemon", plugin: "release", deadline: 0 }]),
  );
  const app = await open("/skills");
  await screen.findByRole("heading", { level: 1, name: "code-review" });
  // Hidden from the first paint, then removed on the daemon.
  expect(within(catalog()).queryByText("release-notes")).toBeNull();
  await waitFor(async () => expect(await installed(app)).not.toContain("release"));
  expect(localStorage.getItem("ace.skills.removing")).toBeNull();
  expect(await installed(app)).toContain("engineering");
});

test("a pending removal for another daemon is left alone", async () => {
  localStorage.setItem(
    "ace.skills.removing",
    JSON.stringify([{ daemon: "wss://elsewhere:7417", plugin: "release", deadline: 0 }]),
  );
  const app = await open("/skills");
  await screen.findByRole("heading", { level: 1, name: "code-review" });
  expect(within(catalog()).getByText("release-notes")).toBeTruthy();
  expect(await installed(app)).toContain("release");
});

test("Stop while a review is being made cancels that review once the daemon makes it", async () => {
  const app = await open("/skills");
  await screen.findByRole("heading", { level: 1, name: "code-review" });
  // Hold the daemon's answer to plugins.prepare until after Stop.
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const request = app.client.request.bind(app.client);
  app.client.request = ((input: Parameters<typeof request>[0], options) =>
    input.type === "pluginRequest" && input.request.type === "plugins.prepare"
      ? held.then(() => request(input, options))
      : request(input, options)) as typeof app.client.request;

  await userEvent.click(screen.getByRole("button", { name: "Install plugin" }));
  const dialog = await screen.findByRole("dialog", { name: "Install a plugin" });
  await userEvent.type(within(dialog).getByLabelText("Repository"), "getsentry/sentry");
  await userEvent.click(within(dialog).getByRole("button", { name: "Find plugins" }));
  await userEvent.click(await within(dialog).findByRole("button", { name: "Review" }));
  await userEvent.click(await within(dialog).findByRole("button", { name: "Stop" }));
  expect(await within(dialog).findByRole("button", { name: "Review" })).toBeTruthy();

  release();
  // The review the daemon made after Stop doesn't stay pending.
  await waitFor(async () => expect((await pluginList(app)).reviews).toEqual([]));
  expect(screen.queryByRole("dialog", { name: /^Review / })).toBeNull();
});

test("a daemon without plugins offers to install one from the main pane", async () => {
  await harness().open("/skills");

  expect(await screen.findByRole("heading", { name: "No skills yet" })).toBeTruthy();
  expect(screen.getByText("No plugins installed")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Install a plugin" }));
  expect(await screen.findByRole("dialog", { name: "Install a plugin" })).toBeTruthy();
});

test("a skill that isn't installed offers the way back", async () => {
  await open("/skills/engineering~skill~gone");

  expect(await screen.findByRole("heading", { name: "This isn't installed" })).toBeTruthy();
  await userEvent.click(screen.getByRole("link", { name: "Back to Skills" }));
  expect(await screen.findByRole("heading", { level: 1, name: "code-review" })).toBeTruthy();
});

test("when the daemon can't list plugins, Skills says so once and reads them again on Try again", async () => {
  const app = harness();
  app.daemon.seedServices(workbenchServices(Date.now()));
  app.daemon.failRequests("pluginRequest");
  await app.open("/skills");

  expect(
    await screen.findByText(
      "The daemon didn't answer. This loads again once it does.",
      {},
      { timeout: 4000 },
    ),
  ).toBeTruthy();
  expect(screen.queryByText("unavailable")).toBeNull();
  const aside = within(screen.getByRole("complementary", { name: "Skills" }));
  expect(aside.getByText("Couldn't load the list.")).toBeTruthy();
  app.daemon.restoreRequests();
  await userEvent.click(
    within(screen.getByRole("main")).getByRole("button", { name: "Try again" }),
  );
  expect(
    await within(await screen.findByRole("navigation", { name: "Skills catalog" })).findByText(
      "code-review",
    ),
  ).toBeTruthy();
});
