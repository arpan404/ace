import { facts, type Scenario } from "@ace/fake-daemon";
import type { ClientApi } from "@ace/client";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { fakeClient, harness } from "@/test/harness.tsx";

const { endTurn, message, rootAgent, turn } = facts;

/** A thread in `workspace`, still working or finished. */
function thread(id: string, workspace: string, working: boolean): Scenario {
  return {
    thread: {
      id,
      workspaceId: workspace,
      title: working ? "Index the docs" : "Fix the footer",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("claude", `/home/dev/${workspace}`),
          turn("root"),
          message("root", "ask", "user", "Go"),
          ...(working ? [] : [endTurn("root")]),
        ],
      },
    ],
  };
}

function withProjects(working: boolean) {
  const made = harness();
  made.daemon.projects.seedFolders("/home/dev", [{ path: "/home/dev/site", git: true }]);
  made.play(thread("thread-docs", "docs", working)).runUntilBlocked();
  return made;
}
const listed = (made: ReturnType<typeof harness>) =>
  made.daemon.projects.list().workspaces.map((project) => project.name);
/** Show one project on Home; its menu stays open with that project's actions. */
async function filterTo(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name }));
  await screen.findByRole("button", { name: `Project filter: ${name}` });
  await userEvent.pointer({
    keys: "[MouseRight]",
    target: await screen.findByRole("menuitemradio", { name }),
  });
}
async function ready(client: ClientApi) {
  await client.start();
  await vi.waitFor(() => expect(client.state).toBe("ready"));
}

test("the project menu edits the name of a project without threads", async () => {
  const made = withProjects(false);
  const other = fakeClient(made.daemon);
  await ready(other);
  await other.projects.add({ path: "/home/dev/site" });
  await made.open("/new");
  await filterTo("site");
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit project…" }));

  const dialog = await screen.findByRole("dialog", { name: "Edit project" });
  expect(within(dialog).getByText(/The folder on disk keeps its name/)).toBeTruthy();
  const field = within(dialog).getByRole("textbox", { name: "Name" });
  await userEvent.clear(field);
  await userEvent.type(field, "Marketing site");
  expect(within(dialog).queryByRole("textbox", { name: "Icon URL" })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Upload image" })).toBeNull();
  await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

  await screen.findByRole("button", { name: "Project filter: Marketing site" });
  expect(listed(made)).toContain("Marketing site");
  expect(
    made.daemon.projects.list().workspaces.find((project) => project.name === "Marketing site")
      ?.icon,
  ).toBeUndefined();
});

test("removing a project keeps its files and stops listing it", async () => {
  const made = withProjects(false);
  await made.open("/new");
  await filterTo("docs");
  await userEvent.click(await screen.findByRole("menuitem", { name: "Remove…" }));
  const dialog = await screen.findByRole("dialog", { name: "Remove docs?" });
  expect(within(dialog).getByText(/This won't delete any files/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Remove project" }));

  // With the last project gone, the toolbar offers adding one.
  await within(await screen.findByRole("complementary", { name: "Threads" })).findByRole("button", {
    name: "Add project",
  });
  expect(screen.queryByRole("button", { name: /^Project filter:/ })).toBeNull();
  expect(listed(made)).not.toContain("docs");
});

test("a project with running threads is removed only by archiving them", async () => {
  const made = withProjects(true);
  await made.open("/new");
  await filterTo("docs");
  await userEvent.click(await screen.findByRole("menuitem", { name: "Remove…" }));
  const dialog = await screen.findByRole("dialog", { name: "Remove docs?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Remove project" }));

  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "A thread in docs is still running.",
  );
  expect(listed(made)).toContain("docs");
  await userEvent.click(within(dialog).getByRole("button", { name: "Archive threads and remove" }));
  await waitFor(() => expect(listed(made)).not.toContain("docs"));
  const view = made.daemon.snapshot({ kind: "threads" });
  const entry = view?.kind === "threads" ? view.threads["thread-docs"] : undefined;
  expect(entry?.archivedAt).toBeDefined();
});

test("projects added on another device appear without a reload", async () => {
  const made = withProjects(false);
  await made.open("/new");
  await screen.findByRole("button", { name: "Project: docs" });
  const other = fakeClient(made.daemon);
  await ready(other);
  await other.projects.add({ path: "/home/dev/site" });

  await userEvent.click(await screen.findByRole("button", { name: /^Project:/ }));
  expect(await screen.findByRole("option", { name: "site" })).toBeTruthy();
  // The picker ends with Add project.
  expect(
    within(screen.getByRole("dialog", { name: "Choose project" })).getByRole("button", {
      name: "Add project",
    }),
  ).toBeTruthy();
});

test("an unselected project has Edit, Remove and Open in from its context menu", async () => {
  const made = withProjects(false);
  await made.open("/new");
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter:/ }));
  await userEvent.pointer({
    keys: "[MouseRight]",
    target: await screen.findByRole("menuitemradio", { name: "docs" }),
  });
  const menu = await screen.findByRole("menu", { name: "Actions for docs" });
  expect(within(menu).getByRole("menuitem", { name: "Edit project…" })).toBeTruthy();
  expect(within(menu).getByRole("menuitem", { name: "Remove…" })).toBeTruthy();
  const launches: string[] = [];
  const original = window.open;
  window.open = (url) => {
    launches.push(String(url));
    return null;
  };
  try {
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Open in…" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Visual Studio Code" }));
    await waitFor(() => expect(launches).toEqual(["vscode://file/fake/docs"]));
    expect(await screen.findByText("Opened in Visual Studio Code")).toBeTruthy();
  } finally {
    window.open = original;
  }
});

test("a refused edit keeps its draft and retries the name", async () => {
  const made = withProjects(false);
  await made.open("/new");
  await filterTo("docs");
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit project…" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit project" });
  const name = within(dialog).getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Documentation");
  made.daemon.refuseCommands("project_failed", "workspace.rename");
  await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await within(dialog).findByRole("alert");
  expect(name).toHaveProperty("value", "Documentation");
  expect(listed(made)).toContain("docs");
  made.daemon.restoreRequests();
  await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await screen.findByRole("button", { name: "Project filter: Documentation" });
  expect(
    made.daemon.projects.list().workspaces.find((project) => project.name === "Documentation")
      ?.icon,
  ).toBeUndefined();
});

test("renaming a project keeps its detected favicon and offers no artwork editing", async () => {
  const made = harness();
  const favicon = "data:image/png;base64,aGVsbG8=";
  made.daemon.projects.seedFolders("/home/dev", [{ path: "/home/dev/site", favicon }]);
  await ready(made.client);
  await made.client.projects.add({ path: "/home/dev/site" });
  await made.open("/new");
  const picker = await screen.findByRole("button", { name: "Setup project: site" });
  await waitFor(() => expect(picker.querySelector("img")?.getAttribute("src")).toBe(favicon));
  await filterTo("site");
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit project…" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit project" });
  expect(dialog.querySelector("img")?.getAttribute("src")).toBe(favicon);
  expect(within(dialog).queryByRole("textbox", { name: "Icon URL" })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Upload image" })).toBeNull();
  const name = within(dialog).getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Website");
  await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await screen.findByRole("button", { name: "Project filter: Website" });
  expect(made.daemon.projects.list().workspaces[0]?.defaultIcon).toBe(favicon);
});
