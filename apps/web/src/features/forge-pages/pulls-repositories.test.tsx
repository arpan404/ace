import { seedForgeBrowse, seedGitLabMirror, workbench } from "@ace/fake-daemon";
import { WorkspaceId, type ForgeRepository } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { fakeClient, harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

const gitlab: ForgeRepository = { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "ace" };
const githubTitle = /Pull requests and issues page/;
const gitlabTitle = /Mirror CI: run the release checks on GitLab runners/;

/** Project `ace` with its GitHub origin's reviews and its GitLab mirror's merge requests. */
function app() {
  const made = harness();
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  seedForgeBrowse(made.daemon, Date.now());
  seedGitLabMirror(made.daemon, Date.now());
  return made;
}

const list = () => screen.findByRole("navigation", { name: "Pull requests" });
const rowWith = (title: RegExp) =>
  within(screen.getByRole("navigation", { name: "Pull requests" }))
    .getAllByRole("listitem")
    .find((item) => within(item).queryByRole("link", { name: title }) !== null);

test.each([
  ["newest first", "/pulls?project=ace&sort=updated"],
  ["by next move", "/pulls?project=ace"],
])(
  "Code review lists ace's GitHub and GitLab reviews together, %s, each naming its repository",
  async (_, path) => {
    const made = app();
    await made.open(path);
    const nav = await list();
    expect(await within(nav).findByRole("link", { name: gitlabTitle })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: githubTitle })).toBeTruthy();
    expect(within(rowWith(gitlabTitle) ?? nav).getByText("GitLab · acme/ace")).toBeTruthy();
    expect(within(rowWith(githubTitle) ?? nav).getByText("GitHub · acme/ace")).toBeTruthy();
    // The GitLab row opens its own repository, never GitHub's same-numbered review.
    expect(within(nav).getByRole("link", { name: gitlabTitle }).getAttribute("href")).toContain(
      "gitlab%40gitlab.com%2Facme%2Face",
    );
  },
);

test("hiding the GitLab mirror from another device takes its reviews off the list", async () => {
  const made = app();
  const other = fakeClient(made.daemon);
  await other.start();
  await vi.waitFor(() => expect(other.state).toBe("ready"));
  await made.open("/pulls?project=ace&sort=updated");
  const nav = await list();
  await within(nav).findByRole("link", { name: gitlabTitle });

  const saved = await other.command(
    {
      type: "workspace.repositories.set",
      workspaceId: WorkspaceId.parse("ace"),
      repositories: { added: [], hidden: [gitlab], primary: null },
    },
    {},
    "hide-mirror",
  );
  expect(saved).toMatchObject({ ok: true });
  await waitFor(() => expect(within(nav).queryByRole("link", { name: gitlabTitle })).toBeNull());
  expect(within(nav).getByRole("link", { name: githubTitle })).toBeTruthy();
  // One repository again: rows stop naming it.
  expect(within(nav).queryByText("GitHub · acme/ace")).toBeNull();
});
