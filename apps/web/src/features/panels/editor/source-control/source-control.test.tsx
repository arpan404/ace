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

/** Disabled outright, or disabled with a reason (still focusable, `aria-disabled`). */
function isDisabled(element: HTMLElement): boolean {
  return element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
}

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
      branches: ["main", "feat/source-control"],
      refs: [
        { name: "main" },
        {
          name: "feat/source-control",
          upstream: "origin/feat/source-control",
          ahead: 1,
          behind: 0,
        },
        { name: "main", remote: "origin" },
      ],
      ahead: 1,
      behind: 0,
      staged: [{ path: "src/staged.ts", status: "added" }],
      unstaged: [{ path: "src/app.ts", status: "modified" }],
      untracked: [{ path: "src/new.ts", status: "untracked" }],
      stashes: [{ ref: "stash@{0}", index: 0, message: "WIP: saved edits", branch: "main" }],
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

test("commits staged changes, generates a commit message, and supports Commit and push and Amend", async () => {
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

  // Commit staged changes via the primary Commit button.
  await userEvent.click(within(explorer).getByRole("button", { name: "Commit" }));
  await waitFor(() => {
    expect(app.daemon.workspace.sourceControl.commits(thread)).toHaveLength(1);
    expect(app.daemon.workspace.sourceControl.commits(thread)[0]?.stagedOnly).toBe(true);
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  // Commit and push via the split button's menu commits remaining changes and pushes.
  await userEvent.type(box, "Finish remaining changes");
  await userEvent.click(within(explorer).getByRole("button", { name: "More commit actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Commit and push" }));
  await waitFor(() => {
    expect(app.daemon.workspace.sourceControl.commits(thread)).toHaveLength(2);
    expect(within(explorer).getByText("No changes in this checkout.")).toBeTruthy();
  });

  // Amend works even with a clean working tree once a message is entered.
  await userEvent.type(box, "Finish remaining changes (amended)");
  await userEvent.click(within(explorer).getByRole("button", { name: "More commit actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Amend" }));
  await waitFor(() => {
    expect(app.daemon.workspace.sourceControl.commits(thread).at(-1)?.amend).toBe(true);
  });
});

test("confirms discards, waits while the agent works, and asks again for its last turn's edits", async () => {
  const { app, explorer } = await openSourceControl({
    branch: "main",
    branches: ["main"],
    refs: [{ name: "main" }],
    unstaged: [{ path: "src/app.ts", status: "modified" }],
    untracked: [{ path: "src/new.ts", status: "untracked" }],
  });

  // Discard untracked file -> mentions Recently deleted and removes it on confirm.
  const changes = await within(explorer).findByRole("region", { name: "Changes" });
  await userEvent.click(within(changes).getByRole("button", { name: "Discard new.ts" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("new.ts");
  expect(dialog.textContent).toContain("Recently deleted");
  await userEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));
  await waitFor(() => {
    expect(within(explorer).queryByText("new.ts")).toBeNull();
  });

  // While the agent works in the checkout, discarding waits.
  app.daemon.apply(thread, [
    facts.turn("root"),
    facts.tool("root", "live-edit-1", {
      kind: "file.edit",
      title: "Edit src/app.ts",
      detail: {
        kind: "file.edit",
        changes: [{ path: "src/app.ts", kind: "update", oldText: "a", newText: "b" }],
      },
    }),
    facts.toolDone("root", "live-edit-1"),
  ]);
  await waitFor(() => {
    expect(isDisabled(within(explorer).getByRole("button", { name: "Discard app.ts" }))).toBe(true);
  });

  // Once its turn ends, discarding the file that turn edited asks a second time.
  app.daemon.apply(thread, [facts.endTurn("root")]);
  const discard = within(explorer).getByRole("button", { name: "Discard app.ts" });
  await waitFor(() => {
    expect(isDisabled(discard)).toBe(false);
  });
  await userEvent.click(discard);
  const firstStep = await screen.findByRole("dialog");
  expect(firstStep.textContent).toContain("The agent changed app.ts in its last turn");
  await userEvent.click(within(firstStep).getByRole("button", { name: "Continue" }));
  expect(firstStep.textContent).toContain("Discard the agent's latest edits?");
  await userEvent.click(within(firstStep).getByRole("button", { name: "Discard anyway" }));
  await waitFor(() => {
    expect(within(explorer).getByText("No changes in this checkout.")).toBeTruthy();
  });
});

test("a file that changed after the discard dialog opened is kept, and the view says why", async () => {
  const { app, explorer } = await openSourceControl({
    branch: "main",
    branches: ["main"],
    refs: [{ name: "main" }],
    unstaged: [{ path: "src/app.ts", status: "modified" }],
  });
  const changes = await within(explorer).findByRole("region", { name: "Changes" });
  await userEvent.click(within(changes).getByRole("button", { name: "Discard all" }));
  const dialog = await screen.findByRole("dialog");
  // Something writes to the file while the person reads the dialog.
  app.daemon.workspace.touchSourceControl(thread, "src/app.ts");
  await userEvent.click(within(dialog).getByRole("button", { name: /Discard/ }));
  await waitFor(() => {
    expect(within(explorer).getByRole("alert").textContent).toContain(
      "changed after you reviewed it",
    );
  });
  expect(within(changes).getByRole("option", { name: /app/ })).toBeTruthy();
});

test("switches and creates branches, stashes and pops, and waits to switch or pull while the agent works", async () => {
  const { app, explorer } = await openSourceControl();

  // Switch to an existing branch via the branch picker popover.
  await userEvent.click(
    await within(explorer).findByRole("button", { name: "Branch: feat/source-control" }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "main" }));
  await within(explorer).findByRole("button", { name: "Branch: main" });

  // Create a new branch from the picker's filter input.
  await userEvent.click(within(explorer).getByRole("button", { name: "Branch: main" }));
  const filter = await screen.findByRole("textbox", { name: "Filter or create branch" });
  await userEvent.type(filter, "feat/new-branch");
  await userEvent.click(
    await screen.findByRole("button", { name: /Create branch “feat\/new-branch”/ }),
  );
  await within(explorer).findByRole("button", { name: "Branch: feat/new-branch" });

  // Stash including untracked clears changes, and Pop latest stash restores them.
  await userEvent.click(
    within(explorer).getByRole("button", { name: "More source control actions" }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: "Stash including untracked" }));
  await waitFor(() => {
    expect(within(explorer).getByText("No changes in this checkout.")).toBeTruthy();
  });
  await userEvent.click(
    within(explorer).getByRole("button", { name: "More source control actions" }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: "Pop latest stash" }));
  await within(explorer).findByRole("region", { name: "Changes" });

  // While the agent works, switching branches, pulling and stashing wait, and say why.
  app.daemon.apply(thread, [facts.turn("root")]);
  await waitFor(() => {
    expect(
      within(explorer)
        .getByRole("button", { name: "Branch: feat/new-branch" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
  const pull = within(explorer).getByRole("button", { name: "Pull: wait for the agent to finish" });
  expect(pull.hasAttribute("disabled")).toBe(true);
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
