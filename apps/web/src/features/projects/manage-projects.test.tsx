import { facts, type Scenario } from "@ace/fake-daemon";
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
async function ready(client: ReturnType<typeof fakeClient>) {
  await client.start();
  await vi.waitFor(() => expect(client.state).toBe("ready"));
}

test("the project menu lists projects without threads too, and renames the one shown", async () => {
  const made = withProjects(false);
  const other = fakeClient(made.daemon);
  await ready(other);
  await other.projects.add({ path: "/home/dev/site" });
  await made.open("/new");
  await filterTo("site");
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rename site…" }));

  const dialog = await screen.findByRole("dialog", { name: "Rename site" });
  expect(within(dialog).getByText(/The folder on disk keeps its name/)).toBeTruthy();
  const field = within(dialog).getByRole("textbox", { name: "Name" });
  await userEvent.clear(field);
  await userEvent.type(field, "Marketing site{Enter}");

  await screen.findByRole("button", { name: "Project filter: Marketing site" });
  expect(listed(made)).toContain("Marketing site");
});

test("removing a project keeps its files and stops listing it", async () => {
  const made = withProjects(false);
  await made.open("/new");
  await filterTo("docs");
  await userEvent.click(await screen.findByRole("menuitem", { name: "Remove docs…" }));
  const dialog = await screen.findByRole("dialog", { name: "Remove docs?" });
  expect(within(dialog).getByText(/This won't delete any files/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Remove project" }));

  // Home goes back to every project once the one it showed is gone.
  await screen.findByRole("button", { name: "Project filter: All projects" });
  expect(listed(made)).not.toContain("docs");
});

test("a project with running threads is removed only by archiving them", async () => {
  const made = withProjects(true);
  await made.open("/new");
  await filterTo("docs");
  await userEvent.click(await screen.findByRole("menuitem", { name: "Remove docs…" }));
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
  expect(await screen.findByRole("menuitemradio", { name: "site" })).toBeTruthy();
  // The picker ends with Add project.
  expect(screen.getByRole("menuitem", { name: /Add project…/ })).toBeTruthy();
});

test("an unselected project has Rename, Remove and Open in from its context menu", async () => {
  const made = withProjects(false);
  await made.open("/new");
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter:/ }));
  await userEvent.pointer({
    keys: "[MouseRight]",
    target: await screen.findByRole("menuitemradio", { name: "docs" }),
  });
  const menu = await screen.findByRole("menu", { name: "Actions for docs" });
  expect(within(menu).getByRole("menuitem", { name: "Rename docs…" })).toBeTruthy();
  expect(within(menu).getByRole("menuitem", { name: "Remove docs…" })).toBeTruthy();
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
