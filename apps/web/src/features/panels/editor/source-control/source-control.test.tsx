import { coldStartReplay, facts, type FakeSourceControlSeed } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const thread = "thread-cold-start";

const samplePatch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  "-export const version = 1;",
  "+export const version = 2;",
  " export const ready = true;",
  "",
].join("\n");

async function openSourceControl(seed?: FakeSourceControlSeed) {
  const app = harness({ storage: memoryKeyValue() });
  app.play(coldStartReplay()).runThrough("root-replied");
  app.daemon.apply(thread, [facts.toolDone("root", "relay")]);
  app.daemon.checkouts.seed(thread, "src/app.ts", "export const version = 2;\n");
  app.daemon.checkouts.seed(thread, "src/new.ts", "export const fresh = true;\n");
  app.daemon.workspace.setSourceControl(
    thread,
    seed ?? {
      branch: "feat/source-control",
      ahead: 1,
      behind: 0,
      staged: [{ path: "src/staged.ts", status: "added" }],
      unstaged: [{ path: "src/app.ts", status: "modified" }],
      untracked: [{ path: "src/new.ts", status: "untracked" }],
    },
  );
  app.daemon.workspace.setGitDiff(thread, samplePatch);

  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });

  // Open the Editor panel via ⌘P (Ctrl+P in jsdom) so the explorer mounts, then switch to Source control.
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), "app.ts");
  await screen.findByRole("option", { name: /app\.ts/ });
  await userEvent.keyboard("{Enter}");

  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("tab", { name: "app.ts", selected: true });
  await userEvent.click(within(panel).getByRole("button", { name: "Source control" }));

  const explorer = await within(panel).findByRole("complementary", { name: "Explorer" });
  return { app, panel, explorer };
}

test("stages, unstages, and multi-select stages files between Changes and Staged changes", async () => {
  const { explorer } = await openSourceControl();

  const staged = await within(explorer).findByRole("region", { name: "Staged changes" });
  const changes = await within(explorer).findByRole("region", { name: "Changes" });
  expect(within(staged).getByTitle("src/staged.ts")).toBeTruthy();
  expect(within(changes).getByTitle("src/app.ts")).toBeTruthy();
  expect(within(changes).getByTitle("src/new.ts")).toBeTruthy();

  // Stage a single file from Changes -> Staged changes.
  await userEvent.click(within(changes).getByRole("button", { name: "Stage app.ts" }));
  await waitFor(() => {
    expect(
      within(within(explorer).getByRole("region", { name: "Staged changes" })).getByTitle(
        "src/app.ts",
      ),
    ).toBeTruthy();
  });

  // Unstage all moves everything back to Changes.
  await userEvent.click(within(explorer).getByRole("button", { name: "Unstage all" }));
  await waitFor(() => {
    expect(within(explorer).queryByRole("region", { name: "Staged changes" })).toBeNull();
  });

  // Multi-select with Shift-click and stage the selected pair at once.
  const changesNow = within(explorer).getByRole("region", { name: "Changes" });
  const options = within(changesNow).getAllByRole("option");
  await userEvent.click(within(options[0]!).getAllByRole("button")[0]!);
  const user = userEvent.setup();
  await user.keyboard("{Shift>}");
  await user.click(within(options[1]!).getAllByRole("button")[0]!);
  await user.keyboard("{/Shift}");
  await userEvent.click(within(options[0]!).getByRole("button", { name: "Stage 2 files" }));

  await waitFor(() => {
    const stagedNow = within(explorer).getByRole("region", { name: "Staged changes" });
    expect(within(stagedNow).getByTitle("src/app.ts")).toBeTruthy();
    expect(within(stagedNow).getByTitle("src/new.ts")).toBeTruthy();
  });
});

test("Commit takes only what is staged; with nothing staged it stages the listed files, then commits", async () => {
  const { app, explorer } = await openSourceControl();
  app.daemon.workspace.setDraftGenerator(async () => ({
    subject: "Add source control panel",
    body: "Wire staging and commits into the editor explorer.",
  }));

  await within(explorer).findByRole("region", { name: "Staged changes" });

  // Write message populates the commit textarea from git.draft.generate.
  await userEvent.click(within(explorer).getByRole("button", { name: "Write message" }));
  const box = within(explorer).getByRole("textbox", { name: "Commit message" });
  await waitFor(() =>
    expect((box as HTMLTextAreaElement).value).toBe(
      "Add source control panel\n\nWire staging and commits into the editor explorer.",
    ),
  );

  // Commit is the staged file only: the unstaged and untracked files stay listed as changes.
  await userEvent.click(within(explorer).getByRole("button", { name: "Commit" }));
  await waitFor(() => {
    expect(app.daemon.workspace.sourceControl.commits(thread)).toHaveLength(1);
    expect((box as HTMLTextAreaElement).value).toBe("");
  });
  expect(app.daemon.workspace.sourceControl.commits(thread)[0]).toMatchObject({
    stagedOnly: true,
    paths: [],
  });
  const changes = await within(explorer).findByRole("region", { name: "Changes" });
  expect(
    within(changes)
      .getAllByRole("option")
      .map((row) => row.textContent),
  ).toEqual([expect.stringContaining("app"), expect.stringContaining("new")]);

  // Nothing staged now: the button stages the listed files, then commits the index.
  await userEvent.type(box, "Finish remaining changes");
  await userEvent.click(within(explorer).getByRole("button", { name: "More commit actions" }));
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "Stage all, commit and push" }),
  );
  await waitFor(() => {
    expect(app.daemon.workspace.sourceControl.commits(thread)).toHaveLength(2);
    expect(within(explorer).getByText("No changes in this checkout.")).toBeTruthy();
  });
  expect(app.daemon.workspace.sourceControl.commits(thread)[1]).toMatchObject({
    stagedOnly: true,
    paths: [],
  });
  // Amend isn't offered in this view.
  await userEvent.click(within(explorer).getByRole("button", { name: "More commit actions" }));
  expect(screen.queryByRole("menuitem", { name: /Amend/ })).toBeNull();
});

test("Open changes opens the file diff in the editor via editor-compare, and Open file returns to editing", async () => {
  const { panel, explorer } = await openSourceControl();

  const changes = await within(explorer).findByRole("region", { name: "Changes" });
  await userEvent.click(within(changes).getByRole("button", { name: "Open changes for app.ts" }));

  const compare = await within(panel).findByRole("region", { name: "Changes in src/app.ts" });
  await waitFor(() => {
    expect(compare.textContent).toContain("export const version = 1;");
    expect(compare.textContent).toContain("export const version = 2;");
  });

  await userEvent.click(within(compare).getByRole("button", { name: "Open file" }));
  await waitFor(() => {
    expect(within(panel).queryByRole("region", { name: "Changes in src/app.ts" })).toBeNull();
  });
});

test("a failed fetch still shows what it learned, alongside the error", async () => {
  const { explorer } = await openSourceControl({
    branch: "main",
    behind: 0,
    fetchError: "git_remote_unreachable",
    fetchErrorBehind: 3,
  });
  await userEvent.click(await within(explorer).findByRole("button", { name: "Fetch" }));
  await within(explorer).findByRole("alert");
  await within(explorer).findByLabelText("3 behind");
});

test("one Git action at a time: Commit waits while a stage is still finishing", async () => {
  const { app, explorer } = await openSourceControl({
    branch: "main",
    staged: [{ path: "src/staged.ts", status: "added" }],
    unstaged: [{ path: "src/app.ts", status: "modified" }],
  });
  const box = await within(explorer).findByRole("textbox", { name: "Commit message" });
  await userEvent.type(box, "Ship it");
  // The stage lands, but reading the checkout back is slow.
  const slow = app.daemon.workspace.holdGitStatus(thread);
  await userEvent.click(within(explorer).getByRole("button", { name: "Stage app.ts" }));
  await slow.entered;
  const commit = within(explorer).getByRole("button", { name: "Commit" });
  expect(commit.hasAttribute("disabled")).toBe(true);
  box.focus();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(app.daemon.workspace.sourceControl.commits(thread)).toHaveLength(0);

  slow.release();
  await waitFor(() => expect(commit.hasAttribute("disabled")).toBe(false));
  await userEvent.click(commit);
  await waitFor(() => expect(app.daemon.workspace.sourceControl.commits(thread)).toHaveLength(1));
});
