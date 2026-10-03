import { workbenchServices } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const catalog = () => screen.getByRole("navigation", { name: "Skills catalog" });

/** The design's daemon: two plugins installed, and a third its marketplace offers. */
async function open(path: string) {
  const app = harness();
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open(path);
  return app;
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

test("searching and filtering by plugin narrow the catalog", async () => {
  await open("/skills");
  await screen.findByRole("navigation", { name: "Skills catalog" });

  await userEvent.type(screen.getByRole("searchbox", { name: "Search skills" }), "PR");
  await waitFor(() => expect(within(catalog()).queryByText("tdd")).toBeNull());
  expect(within(catalog()).getByText("pr-desc")).toBeTruthy();

  await userEvent.clear(screen.getByRole("searchbox", { name: "Search skills" }));
  await userEvent.click(screen.getByRole("button", { name: "Plugin: All plugins" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "release" }));
  await waitFor(() => expect(within(catalog()).queryByText("code-review")).toBeNull());
  expect(within(catalog()).getByText("release-notes")).toBeTruthy();
  expect(within(catalog()).getByText("standup")).toBeTruthy();
});

test("turning a plugin on turns on everything it ships", async () => {
  await open("/skills/release~skill~release-notes");
  await screen.findByRole("heading", { level: 1, name: "release-notes" });
  const row = within(catalog()).getByRole("link", { name: /release-notes/ });
  expect(row.textContent).toContain("off");

  await userEvent.click(screen.getByRole("switch", { name: "Enabled" }));

  await waitFor(() => expect(row.textContent).not.toContain("off"));
  expect(within(catalog()).getByRole("link", { name: /standup/ }).textContent).not.toContain("off");
});

test("choosing the providers a plugin is available to reads back in words", async () => {
  await open("/skills/plugin~release");
  await screen.findByRole("heading", { level: 1, name: "release" });
  expect(screen.getByText("Claude Code only")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Change" }));
  await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Codex" }));

  expect(await screen.findByText("Claude Code and Codex")).toBeTruthy();
});

test("installing a plugin shows what it runs, and accepting installs it", async () => {
  await open("/skills");
  await screen.findByRole("heading", { level: 1, name: "code-review" });

  await userEvent.click(screen.getByRole("button", { name: "Add skill or plugin" }));
  const dialog = await screen.findByRole("dialog", { name: "Install a plugin" });
  await userEvent.type(within(dialog).getByLabelText("Repository"), "not a repo");
  await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));
  expect(within(dialog).getByRole("alert").textContent).toContain("owner/name");

  await userEvent.clear(within(dialog).getByLabelText("Repository"));
  await userEvent.type(within(dialog).getByLabelText("Repository"), "getsentry/sentry");
  await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));

  const review = await screen.findByRole("dialog", { name: "Review sentry 0.9.0" });
  const runs = within(within(review).getByRole("list", { name: "What it runs" }));
  expect(runs.getByText("MCP server sentry")).toBeTruthy();
  expect(runs.getByText("npx -y @sentry/mcp-server@0.9.0")).toBeTruthy();
  await userEvent.click(within(review).getByRole("button", { name: "Install" }));

  expect(await screen.findByRole("heading", { level: 1, name: "sentry" })).toBeTruthy();
  const plugins = within(catalog()).getByRole("region", { name: "Plugins" });
  expect(await within(plugins).findByText("sentry")).toBeTruthy();
  expect(within(catalog()).getByText("triage-issue")).toBeTruthy();
});

test("cancelling a review installs nothing", async () => {
  await open("/skills");
  await screen.findByRole("heading", { level: 1, name: "code-review" });
  await userEvent.click(screen.getByRole("button", { name: "Add skill or plugin" }));
  const dialog = await screen.findByRole("dialog", { name: "Install a plugin" });
  await userEvent.type(within(dialog).getByLabelText("Repository"), "getsentry/sentry");
  await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));

  const review = await screen.findByRole("dialog", { name: "Review sentry 0.9.0" });
  await userEvent.click(within(review).getByRole("button", { name: "Cancel" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(within(catalog()).queryByText("sentry")).toBeNull();
});

test("removing a plugin takes what it ships out of the catalog", async () => {
  await open("/skills/plugin~release");
  await screen.findByRole("heading", { level: 1, name: "release" });

  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Remove release" }));

  await waitFor(() => expect(within(catalog()).queryByText("release-notes")).toBeNull());
  expect(within(catalog()).getByText("code-review")).toBeTruthy();
});

test("a daemon without plugins says how to add skills", async () => {
  await harness().open("/skills");

  expect(await screen.findByRole("heading", { name: "No skills yet" })).toBeTruthy();
});
