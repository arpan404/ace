import { App, AppFrame } from "@/app.tsx";
import { createMemoryHistory } from "@tanstack/react-router";
import { ClientMessage, ServerMessage } from "@ace/protocol";
import { FakeDaemon, ScenarioPlayer, facts, type Scenario } from "@ace/fake-daemon";
import type { ClientApi } from "@ace/client";
import { act, configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { fakeClient, harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

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
  const field = within(dialog).getByRole("textbox", { name: "Name" });
  await userEvent.clear(field);
  await userEvent.type(field, "Marketing site");
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

test("cancelling a refused removal gives another project and a reopened project a fresh attempt", async () => {
  const made = withProjects(true);
  await ready(made.client);
  await made.client.projects.add({ path: "/home/dev/site" });
  await made.open("/new");
  await filterTo("docs");
  await userEvent.click(await screen.findByRole("menuitem", { name: "Remove…" }));
  const refused = await screen.findByRole("dialog", { name: "Remove docs?" });
  await userEvent.click(within(refused).getByRole("button", { name: "Remove project" }));
  await within(refused).findByRole("alert");
  await userEvent.click(within(refused).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  await filterTo("site");
  await userEvent.click(await screen.findByRole("menuitem", { name: "Remove…" }));
  const fresh = await screen.findByRole("dialog", { name: "Remove site?" });
  expect(within(fresh).queryByRole("alert")).toBeNull();
  await userEvent.click(within(fresh).getByRole("button", { name: "Remove project" }));
  await waitFor(() => expect(listed(made)).not.toContain("site"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  await filterTo("docs");
  await userEvent.click(await screen.findByRole("menuitem", { name: "Remove…" }));
  const reopened = await screen.findByRole("dialog", { name: "Remove docs?" });
  expect(within(reopened).queryByRole("alert")).toBeNull();
  expect(within(reopened).getByRole("button", { name: "Remove project" })).toBeTruthy();
}, 30_000);

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
  made.daemon.refuseCommands("project_failed", "workspace.update");
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

test("renaming a project keeps its detected favicon", async () => {
  const made = harness();
  const favicon = "data:image/png;base64,aGVsbG8=";
  made.daemon.projects.seedFolders("/home/dev", [{ path: "/home/dev/site", favicon }]);
  await ready(made.client);
  await made.client.projects.add({ path: "/home/dev/site" });
  await made.open("/new");
  // New thread names its project inline, without a mark; the edit dialog shows the favicon.
  await screen.findByRole("button", { name: "Project: site" });
  await filterTo("site");
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit project…" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit project" });
  expect(dialog.querySelector("img")?.getAttribute("src")).toBe(favicon);
  const name = within(dialog).getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Website");
  await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await screen.findByRole("button", { name: "Project filter: Website" });
  expect(made.daemon.projects.list().workspaces[0]?.defaultIcon).toBe(favicon);
});

/** Hold correlated removal receipts at the network boundary; other messages keep flowing. */
class DelayedRemovalDaemon extends FakeDaemon {
  private removals = new Set<string>();
  private delayedReceipts: (() => void)[] = [];
  get awaitingReceipt() {
    return this.delayedReceipts.length > 0;
  }
  releaseReceipts() {
    for (const send of this.delayedReceipts.splice(0)) send();
  }
  override connect(wire: Parameters<FakeDaemon["connect"]>[0]) {
    const connection = super.connect({
      ...wire,
      send: (text) => {
        const frame = ServerMessage.parse(JSON.parse(text));
        if (frame.type === "commandResult" && this.removals.delete(frame.commandId))
          this.delayedReceipts.push(() => wire.send(text));
        else wire.send(text);
      },
    });
    const receive = connection.receive.bind(connection);
    connection.receive = (text: string) => {
      const frame = ClientMessage.parse(JSON.parse(text));
      if (frame.type === "command" && frame.command.payload.type === "workspace.remove")
        this.removals.add(frame.command.id);
      receive(text);
    };
    return connection;
  }
}

test.each(["success", "refusal"] as const)(
  "a delayed removal %s cannot close or change a dialog opened after cancellation",
  async (result) => {
    const daemon = new DelayedRemovalDaemon({ clock: () => 1000 });
    new ScenarioPlayer(
      daemon,
      thread("thread-docs", "docs", result === "refusal"),
    ).runUntilBlocked();
    daemon.projects.seedFolders("/home/dev", [{ path: "/home/dev/site", git: true }]);
    daemon.services.providerLogin.dismiss("test-device");
    const client = fakeClient(daemon);
    await ready(client);
    await client.projects.add({ path: "/home/dev/site" });
    const storage = memoryKeyValue();
    const view = render(
      <AppFrame environment={{ storage }}>
        <App
          client={client}
          storage={storage}
          history={createMemoryHistory({ initialEntries: ["/new"] })}
        />
      </AppFrame>,
    );
    await filterTo("docs");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove…" }));
    const old = await screen.findByRole("dialog", { name: "Remove docs?" });
    await userEvent.click(within(old).getByRole("button", { name: "Remove project" }));
    await waitFor(() => expect(daemon.awaitingReceipt).toBe(true));
    await userEvent.click(within(old).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await filterTo("site");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove…" }));
    await screen.findByRole("dialog", { name: "Remove site?" });
    const receipt = Promise.withResolvers<void>();
    const stop = client.onMessage((frame) => {
      if (frame.type === "commandResult") receipt.resolve();
    });
    await act(async () => {
      daemon.releaseReceipts();
      await receipt.promise;
    });
    const current = screen.getByRole("dialog", { name: "Remove site?" });
    expect(within(current).queryByRole("alert")).toBeNull();
    expect(within(current).getByRole("button", { name: "Remove project" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(daemon.projects.list().workspaces.map((project) => project.name)).toContain("site");
    expect(screen.queryByText("Removed docs")).toBeNull();
    stop();
    view.unmount();
  },
);
