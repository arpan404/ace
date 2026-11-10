import { workbench } from "@ace/fake-daemon";
import { cleanup, configure, screen, waitFor, within } from "@testing-library/react";
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

test("the primary offers no Hide; the mirror made primary, origin hidden and a repository added by hand are saved and still there after a reload", async () => {
  const made = app();
  await made.open("/new?project=ace");
  let group = await openRepositories();
  const origin = rowOf(group, "GitHub · acme/ace");
  expect(origin.getByText("Primary")).toBeTruthy();
  expect(origin.getByText("Remote origin")).toBeTruthy();
  expect(rowOf(group, "GitLab · acme/ace").getByText("Remote mirror")).toBeTruthy();
  // The primary can't be hidden, so it offers no Hide.
  expect(origin.queryByRole("button", { name: /^Hide/ })).toBeNull();

  await userEvent.click(group.getByRole("button", { name: "Make primary: GitLab · acme/ace" }));
  await waitFor(() =>
    expect(rowOf(group, "GitLab · acme/ace").queryByText("Primary")).toBeTruthy(),
  );
  await userEvent.click(group.getByRole("button", { name: "Hide: GitHub · acme/ace" }));
  await waitFor(() => expect(rowOf(group, "GitHub · acme/ace").queryByText("Hidden")).toBeTruthy());

  const field = group.getByRole("textbox", { name: "Add a repository by address" });
  await userEvent.type(field, "git@gitlab.com:acme/tools.git");
  expect(group.getByText("GitLab · acme/tools")).toBeTruthy();
  await userEvent.click(group.getByRole("button", { name: "Add" }));
  await waitFor(() =>
    expect(rowOf(group, "GitLab · acme/tools").getByText("Added by hand")).toBeTruthy(),
  );

  expect(made.daemon.projects.repositories.read("ace").config).toEqual({
    added: [tools],
    hidden: [github],
    primary: gitlab,
  });

  cleanup();
  const again = app(made.daemon);
  await again.open("/new?project=ace");
  group = await openRepositories();
  expect(rowOf(group, "GitLab · acme/ace").getByText("Primary")).toBeTruthy();
  expect(rowOf(group, "GitHub · acme/ace").getByText("Hidden")).toBeTruthy();
  expect(rowOf(group, "GitLab · acme/tools").getByText("Added by hand")).toBeTruthy();
});
