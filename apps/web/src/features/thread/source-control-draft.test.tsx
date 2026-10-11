import { facts, type Scenario } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, beforeEach } from "vitest";
import { harness } from "@/test/harness.tsx";
import type { SourceControlDraft, ThreadDetails } from "@ace/protocol";

configure({ asyncUtilTimeout: 10000 });
beforeEach(() => localStorage.clear());
const scenario: Scenario = {
  thread: {
    id: "draft-thread",
    workspaceId: "scratch",
    title: "Person's initial text",
    provider: "claude",
    details: {
      mode: "local",
      worktree: "/Users/dev/scratch",
      branch: "feature",
      baseBranch: "main",
      head: "a".repeat(40),
      diff: { files: 2, additions: 2, deletions: 0 },
      repository: { forge: "github", host: "github.com", owner: "acme", name: "repo" },
    },
  },
  steps: [{ kind: "facts", label: "ready", facts: [facts.rootAgent("claude")] }],
};
async function open(kind: "commit" | "pr" = "commit", details: Partial<ThreadDetails> = {}) {
  const app = harness();
  app.play({
    ...scenario,
    thread: { ...scenario.thread, details: { ...scenario.thread.details, ...details } },
  }).runThrough("ready");
  app.daemon.workspace.setGitStatus(
    "draft-thread",
    ["selected.ts", "excluded.ts"].map((path) => ({
      path,
      status: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
    })),
  );
  app.daemon.workspace.setGitDiff("draft-thread", "+selected change\n");
  await app.open("/t/draft-thread");
  await screen.findByRole("heading", { level: 1, name: "Person's initial text" });
  await userEvent.click(screen.getByRole("button", { name: /^Work card/ }));
  const card = await screen.findByRole("complementary", { name: "Work card" });
  await userEvent.click(await within(card).findByRole("button", { name: "Git actions" }));
  await userEvent.click(
    await screen.findByRole("menuitem", {
      name: kind === "commit" ? /^Commit & push/ : /^Create PR(?:…)?$/,
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: kind === "commit" ? /^Commit to/ : "Open a pull request",
  });
  if (kind === "commit") {
    await within(dialog).findByRole("list", { name: "Files to commit" });
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Push after committing" }));
  }
  return { app, dialog, form: within(dialog) };
}

test("a generated commit is reviewed, edited and submitted only for the selected files", async () => {
  const { app, form } = await open();
  await userEvent.click(form.getByRole("checkbox", { name: "excluded.ts" }));
  await userEvent.click(form.getByRole("button", { name: "Generate draft" }));
  await form.findByLabelText("Generated draft");
  expect(form.getByRole("textbox", { name: "Commit message" })).toHaveProperty(
    "value",
    "Person's initial text",
  );
  expect(app.daemon.workspace.gitStatus("draft-thread")).toHaveLength(2);
  await userEvent.click(form.getByRole("button", { name: "Use draft" }));
  const message = form.getByRole("textbox", { name: "Commit message" });
  await userEvent.clear(message);
  await userEvent.type(message, "fix: my reviewed wording");
  expect(form.getByRole("textbox", { name: "Commit details" })).toHaveProperty(
    "value",
    "- Update selected.ts",
  );
  await userEvent.click(form.getByText("Sources for this draft"));
  expect(form.getByText("+selected change")).toBeTruthy();
  await userEvent.click(form.getByRole("button", { name: /^Commit(?! &)/ }));
  await screen.findByText("Committed");
  expect(app.daemon.workspace.gitStatus("draft-thread").map((file) => file.path)).toEqual([
    "excluded.ts",
  ]);
});

test("editing text during generation prevents a late draft from replacing it", async () => {
  const { app, form } = await open();
  let finish: ((draft: SourceControlDraft) => void) | undefined;
  let started = false;
  app.daemon.workspace.setDraftGenerator(async () => {
    started = true;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await userEvent.click(form.getByRole("button", { name: "Generate draft" }));
  await waitFor(() => expect(started).toBe(true));
  const input = form.getByRole("textbox", { name: "Commit message" });
  await userEvent.type(input, " with my new edit");
  await act(async () => finish?.({ subject: "Late provider text", body: "Late body" }));
  await form.findByLabelText("Generated draft");
  expect(input).toHaveProperty("value", "Person's initial text with my new edit");
  expect(form.getByRole("button", { name: "Use draft" })).toHaveProperty("disabled", true);
  expect(app.daemon.workspace.gitStatus("draft-thread")).toHaveLength(2);
});

test("cancellation preserves typed text and file selection even if a provider returns later", async () => {
  const { app, form } = await open();
  let finish: ((draft: SourceControlDraft) => void) | undefined;
  let started = false;
  app.daemon.workspace.setDraftGenerator(async () => {
    started = true;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await userEvent.click(form.getByRole("checkbox", { name: "excluded.ts" }));
  await userEvent.click(form.getByRole("button", { name: "Generate draft" }));
  await waitFor(() => expect(started).toBe(true));
  await userEvent.click(form.getByRole("button", { name: "Cancel generation" }));
  await act(async () => finish?.({ subject: "Cancelled provider text", body: "" }));
  expect(form.queryByLabelText("Generated draft")).toBeNull();
  expect(form.getByRole("textbox", { name: "Commit message" })).toHaveProperty(
    "value",
    "Person's initial text",
  );
  expect(form.getByRole("checkbox", { name: "excluded.ts" }).getAttribute("aria-checked")).toBe(
    "false",
  );
});

test("changing the selection after applying a draft blocks submitting its old summary", async () => {
  const { form } = await open();
  await userEvent.click(form.getByRole("button", { name: "Generate draft" }));
  await form.findByLabelText("Generated draft");
  await userEvent.click(form.getByRole("button", { name: "Use draft" }));
  await userEvent.click(form.getByRole("checkbox", { name: "excluded.ts" }));
  expect(form.getByRole("button", { name: /^Commit(?! &)/ })).toHaveProperty("disabled", true);
  expect(form.getByRole("textbox", { name: "Commit message" })).toHaveProperty(
    "value",
    "Update selected changes",
  );
});

test("provider failure keeps both typed fields and the selected paths", async () => {
  const { app, form } = await open();
  app.daemon.workspace.setDraftGenerator(async () => {
    throw new Error("draft_provider_unavailable");
  });
  await userEvent.type(form.getByRole("textbox", { name: "Commit details" }), "Person's details");
  await userEvent.click(form.getByRole("button", { name: "Generate draft" }));
  await form.findByRole("alert");
  expect(form.getByRole("textbox", { name: "Commit details" })).toHaveProperty(
    "value",
    "Person's details",
  );
  expect(form.getAllByRole("checkbox", { checked: true })).toHaveLength(2);
});

test("PR generation leaves publication explicit and the title and description editable", async () => {
  const { app, form } = await open("pr");
  const scope = { kind: "thread" as const, threadId: ThreadId.parse("draft-thread") };
  const before = app.daemon.snapshot(scope);
  await userEvent.click(form.getByRole("button", { name: "Generate draft" }));
  await form.findByLabelText("Generated draft");
  expect(form.getByRole("textbox", { name: "Pull request description" })).toHaveProperty(
    "value",
    "",
  );
  await userEvent.click(form.getByRole("button", { name: "Use draft" }));
  await userEvent.type(
    form.getByRole("textbox", { name: "Pull request description" }),
    "\nReviewed by me.",
  );
  expect(form.getByRole("textbox", { name: "Pull request description" })).toHaveProperty(
    "value",
    "- Update excluded.ts\n- Update selected.ts\nReviewed by me.",
  );
  expect(form.getByRole("button", { name: /^Create PR/ })).toBeTruthy();
  expect(app.daemon.snapshot(scope)).toEqual(before);
});

test("PR generation sends the recorded remote Git base while the form names its forge branch", async () => {
  const { app, form } = await open("pr", {
    baseBranch: "origin/release",
    base: { ref: "release", remote: "origin", head: "b".repeat(40), fetch: "fetched" },
  });
  app.daemon.workspace.setDraftGenerator(async (input) => ({
    subject: input.selection.kind === "pr" ? `Compared ${input.selection.baseRef}` : "Wrong scope",
    body: input.selection.kind === "pr" ? `Merge into ${input.selection.base}` : "",
  }));
  await userEvent.click(form.getByRole("button", { name: "Generate draft" }));
  await form.findByLabelText("Generated draft");
  await userEvent.click(form.getByRole("button", { name: "Use draft" }));
  expect(form.getByRole("textbox", { name: "Pull request title" })).toHaveProperty(
    "value", "Compared refs/remotes/origin/release",
  );
  expect(form.getByRole("textbox", { name: "Pull request description" })).toHaveProperty(
    "value", "Merge into release",
  );
});

test("reconnect discards a pending result and never requests another generation", async () => {
  const { app, form } = await open();
  let finish: ((draft: SourceControlDraft) => void) | undefined;
  let requests = 0;
  app.daemon.workspace.setDraftGenerator(async () => {
    requests++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await userEvent.click(form.getByRole("button", { name: "Generate draft" }));
  await waitFor(() => expect(requests).toBe(1));
  await act(async () => app.daemon.disconnectAll());
  await waitFor(() =>
    expect(form.getByRole("button", { name: "Generate draft" })).toHaveProperty("disabled", false),
  );
  await act(async () => finish?.({ subject: "Disconnected result", body: "" }));
  expect(form.queryByLabelText("Generated draft")).toBeNull();
  expect(form.getByRole("textbox", { name: "Commit message" })).toHaveProperty(
    "value",
    "Person's initial text",
  );
  expect(requests).toBe(1);
});
