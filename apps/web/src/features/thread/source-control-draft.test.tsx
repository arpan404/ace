import { gitAction } from "@/test/open-work.ts";
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
type Generator = Parameters<
  ReturnType<typeof harness>["daemon"]["workspace"]["setDraftGenerator"]
>[0];

async function open(
  kind: "commit" | "pr" = "commit",
  details: Partial<ThreadDetails> = {},
  generator?: Generator,
  prepare?: (app: ReturnType<typeof harness>) => void,
) {
  const app = harness();
  if (generator) app.daemon.workspace.setDraftGenerator(generator);
  prepare?.(app);
  app
    .play({
      ...scenario,
      thread: { ...scenario.thread, details: { ...scenario.thread.details, ...details } },
    })
    .runThrough("ready");
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
  await gitAction(kind === "commit" ? /^Commit & push/ : /^Create PR(?:…)?$/);
  const dialog = await screen.findByRole("dialog", {
    name: kind === "commit" ? /^Commit to/ : "Open a pull request",
  });
  if (kind === "commit") {
    await within(dialog).findByRole("list", { name: "Files to commit" });
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Push after committing" }));
  }
  return { app, dialog, form: within(dialog) };
}

/** A generator that waits until the test finishes it, counting its requests. */
function held() {
  const state = {
    requests: 0,
    finish: undefined as ((draft: SourceControlDraft) => void) | undefined,
  };
  const generator: Generator = async () => {
    state.requests++;
    return new Promise((resolve) => {
      state.finish = resolve;
    });
  };
  return { state, generator };
}

test("the commit message is drafted from the picked files as the form opens, and follows the picks until edited", async () => {
  const { app, form } = await open();
  const message = form.getByRole("textbox", { name: "Commit message" });
  const details = form.getByRole("textbox", { name: "Commit details" });
  // No Generate click: the draft lands in the fields on its own.
  await waitFor(() => expect(message).toHaveProperty("value", "Update selected changes"));
  expect(details).toHaveProperty("value", "- Update excluded.ts\n- Update selected.ts");
  // Unpicking a file drafts again for what is left, while the text is still the draft's.
  await userEvent.click(form.getByRole("checkbox", { name: "excluded.ts" }));
  await waitFor(() => expect(details).toHaveProperty("value", "- Update selected.ts"));
  await userEvent.clear(message);
  await userEvent.type(message, "fix: my reviewed wording");
  const commit = form.getByRole("button", { name: /^Commit(?! &)/ });
  await waitFor(() => expect(commit).toHaveProperty("disabled", false));
  await userEvent.click(commit);
  await screen.findByText("Committed");
  expect(app.daemon.workspace.gitStatus("draft-thread").map((file) => file.path)).toEqual([
    "excluded.ts",
  ]);
});

test("a generated commit is reviewed, edited and submitted only for the selected files", async () => {
  const { app, form } = await open();
  const typed = form.getByRole("textbox", { name: "Commit message" });
  await waitFor(() => expect(typed).toHaveProperty("value", "Update selected changes"));
  await userEvent.clear(typed);
  await userEvent.type(typed, "Person's initial text");
  await userEvent.click(form.getByRole("checkbox", { name: "excluded.ts" }));
  await userEvent.click(form.getByRole("button", { name: /^Draft$/ }));
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

test("editing text while the opening draft is written keeps the person's text", async () => {
  const { state, generator } = held();
  const { app, form } = await open("commit", {}, generator);
  await waitFor(() => expect(state.requests).toBe(1));
  const input = form.getByRole("textbox", { name: "Commit message" });
  await userEvent.type(input, " with my new edit");
  await act(async () => state.finish?.({ subject: "Late provider text", body: "Late body" }));
  await form.findByLabelText("Generated draft");
  expect(input).toHaveProperty("value", "Person's initial text with my new edit");
  expect(form.getByRole("button", { name: "Use draft" })).toHaveProperty("disabled", true);
  expect(app.daemon.workspace.gitStatus("draft-thread")).toHaveLength(2);
});

test("cancellation preserves typed text and file selection even if a provider returns later", async () => {
  const { state, generator } = held();
  const { form } = await open("commit", {}, generator);
  await userEvent.click(form.getByRole("checkbox", { name: "excluded.ts" }));
  await waitFor(() => expect(state.requests).toBe(2));
  await userEvent.click(form.getByRole("button", { name: "Cancel generation" }));
  await act(async () => state.finish?.({ subject: "Cancelled provider text", body: "" }));
  expect(form.queryByLabelText("Generated draft")).toBeNull();
  expect(form.getByRole("textbox", { name: "Commit message" })).toHaveProperty(
    "value",
    "Person's initial text",
  );
  expect(form.getByRole("checkbox", { name: "excluded.ts" }).getAttribute("aria-checked")).toBe(
    "false",
  );
});

test("changing the selection after editing a draft blocks submitting its old summary", async () => {
  const { form } = await open();
  const details = form.getByRole("textbox", { name: "Commit details" });
  await waitFor(() =>
    expect(details).toHaveProperty("value", "- Update excluded.ts\n- Update selected.ts"),
  );
  await userEvent.type(details, " by hand");
  await userEvent.click(form.getByRole("checkbox", { name: "excluded.ts" }));
  expect(form.getByRole("button", { name: /^Commit(?! &)/ })).toHaveProperty("disabled", true);
  expect(form.getByRole("textbox", { name: "Commit message" })).toHaveProperty(
    "value",
    "Update selected changes",
  );
});

test("a failed opening draft is silent; a failed Draft says so and keeps typed fields and paths", async () => {
  let requests = 0;
  const { form } = await open("commit", {}, async () => {
    requests++;
    throw new Error("draft_provider_unavailable");
  });
  await waitFor(() => expect(requests).toBe(1));
  await waitFor(() =>
    expect(form.getByRole("button", { name: /^Draft$/ })).toHaveProperty("disabled", false),
  );
  expect(form.queryByRole("alert")).toBeNull();
  expect(form.getByRole("textbox", { name: "Commit message" })).toHaveProperty(
    "value",
    "Person's initial text",
  );
  await userEvent.type(form.getByRole("textbox", { name: "Commit details" }), "Person's details");
  await userEvent.click(form.getByRole("button", { name: /^Draft$/ }));
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
  await userEvent.click(form.getByRole("button", { name: /^Draft$/ }));
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
  await userEvent.click(form.getByRole("button", { name: /^Draft$/ }));
  await form.findByLabelText("Generated draft");
  await userEvent.click(form.getByRole("button", { name: "Use draft" }));
  expect(form.getByRole("textbox", { name: "Pull request title" })).toHaveProperty(
    "value",
    "Compared refs/remotes/origin/release",
  );
  expect(form.getByRole("textbox", { name: "Pull request description" })).toHaveProperty(
    "value",
    "Merge into release",
  );
});

test("reconnect discards a pending result and never requests another generation", async () => {
  const { state, generator } = held();
  const { app, form } = await open("commit", {}, generator);
  await waitFor(() => expect(state.requests).toBe(1));
  await act(async () => app.daemon.disconnectAll());
  await waitFor(() =>
    expect(form.getByRole("button", { name: /^Draft$/ })).toHaveProperty("disabled", false),
  );
  await act(async () => state.finish?.({ subject: "Disconnected result", body: "" }));
  expect(form.queryByLabelText("Generated draft")).toBeNull();
  expect(form.getByRole("textbox", { name: "Commit message" })).toHaveProperty(
    "value",
    "Person's initial text",
  );
  expect(state.requests).toBe(1);
});

test("a moved PR draft preserves its recovery guidance and never publishes stale text", async () => {
  const { app, form } = await open("pr");
  await userEvent.click(form.getByRole("button", { name: /^Draft$/ }));
  await form.findByLabelText("Generated draft");
  await userEvent.click(form.getByRole("button", { name: "Use draft" }));
  app.daemon.workspace.setGitDiff("draft-thread", "+different changes after generation\n");
  await userEvent.click(form.getByRole("button", { name: /^Create PR/ }));
  expect((await form.findByRole("alert")).textContent).toBe(
    "The selected changes moved. Generate again, or discard the draft to use your own text.",
  );
  const snapshot = app.daemon.snapshot({
    kind: "thread",
    threadId: ThreadId.parse("draft-thread"),
  });
  if (!snapshot || snapshot.kind !== "thread") throw new Error("Missing thread snapshot");
  expect(snapshot.thread.details?.linkedPr).toBeUndefined();
  expect(snapshot.thread.details?.linkedPrs ?? []).toEqual([]);
  expect(form.getByRole("button", { name: /^Draft$/ })).toHaveProperty("disabled", false);
  await userEvent.click(form.getByRole("button", { name: /^Draft$/ }));
  await form.findByLabelText("Generated draft");
  await userEvent.click(form.getByRole("button", { name: "Use draft" }));
  await userEvent.click(form.getByRole("button", { name: /^Create PR/ }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Open a pull request" })).toBeNull(),
  );
});

test("with auto-draft off, the commit form asks for no draft until Draft is pressed", async () => {
  const { state, generator } = held();
  const { form } = await open("commit", {}, generator, (app) =>
    app.daemon.services.settings.seed({ "generation.autoDraftCommits": false }),
  );
  const draft = form.getByRole("button", { name: /^Draft$/ });
  await waitFor(() => expect(draft).toHaveProperty("disabled", false));
  expect(state.requests).toBe(0);
  expect(form.getByRole("textbox", { name: "Commit message" })).toHaveProperty(
    "value",
    "Person's initial text",
  );
  await userEvent.click(draft);
  await waitFor(() => expect(state.requests).toBe(1));
});

test("with no provider able to write, the commit form is the manual fields alone", async () => {
  const { state, generator } = held();
  const { form } = await open("commit", {}, generator, (app) => {
    app.daemon.services.settings.seed({
      "providers.configuration": (["claude", "codex", "opencode", "cursor", "pi"] as const).map(
        (provider) => ({ provider, enabled: false }),
      ),
    });
  });
  await waitFor(() =>
    expect(form.queryByRole("region", { name: "Generate source-control draft" })).toBeNull(),
  );
  expect(form.queryByRole("button", { name: /^Draft$/ })).toBeNull();
  expect(form.getByRole("textbox", { name: "Commit message" })).toHaveProperty(
    "value",
    "Person's initial text",
  );
  expect(state.requests).toBe(0);
});
