import { workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

const github = { forge: "github", host: "github.com", owner: "acme", name: "ace" };
const gitlab = { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "ace" };
const tools = { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "tools" };

function app(daemon?: ReturnType<typeof harness>["daemon"]) {
  const made = harness(daemon ? { daemon } : {});
  if (!daemon) for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  return made;
}

async function openRepositories() {
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter:/ }));
  await userEvent.pointer({
    keys: "[MouseRight]",
    target: await screen.findByRole("menuitemradio", { name: "ace" }),
  });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit project…" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit project" });
  const group = within(dialog).getByRole("group", { name: "Repositories" });
  await within(group).findByRole("listitem", { name: "GitHub · acme/ace" });
  return within(group);
}

const rowOf = (group: ReturnType<typeof within>, name: string) =>
  within(group.getByRole("listitem", { name }));

test("removing a repository added by hand and showing a hidden one leave only the primary choice", async () => {
  const made = app();
  made.daemon.projects.repositories.set("ace", {
    added: [tools],
    hidden: [github],
    primary: gitlab,
  });
  await made.open("/new?project=ace");
  const group = await openRepositories();
  await userEvent.click(group.getByRole("button", { name: "Remove: GitLab · acme/tools" }));
  await waitFor(() =>
    expect(group.queryByRole("listitem", { name: "GitLab · acme/tools" })).toBeNull(),
  );
  await userEvent.click(group.getByRole("button", { name: "Show: GitHub · acme/ace" }));
  await waitFor(() => expect(rowOf(group, "GitHub · acme/ace").queryByText("Hidden")).toBeNull());
  expect(made.daemon.projects.repositories.read("ace").config).toEqual({
    added: [],
    hidden: [],
    primary: gitlab,
  });
});

test("an address on a host that isn't configured says so and can't be added", async () => {
  const made = app();
  await made.open("/new?project=ace");
  const group = await openRepositories();
  await userEvent.type(
    group.getByRole("textbox", { name: "Add a repository by address" }),
    "https://git.corp.example/acme/api.git",
  );
  expect(await group.findByText(/git\.corp\.example isn't one of your Git hosts/)).toBeTruthy();
  expect(group.getByRole("link", { name: "Open Source control" })).toBeTruthy();
  expect(group.getByRole<HTMLButtonElement>("button", { name: "Add" }).disabled).toBe(true);
});
