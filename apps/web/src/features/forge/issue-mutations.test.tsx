import { beforeEach, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgeIssueDetail, ForgeIssueSearch, WorkspaceId } from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
import { memoryStorage } from "@/boot/client.ts";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const workspaceId = WorkspaceId.parse("api");
const original = ForgeIssueDetail.parse({
  ref: { repository, number: 42 },
  title: "Original issue",
  body: "Original description",
  url: "https://github.com/acme/api/issues/42",
  author: "author",
  state: "open",
  labels: [],
  assignees: [],
  milestone: null,
  createdAt: "2026-10-10",
  updatedAt: "2026-10-10",
  permissions: {
    edit: true,
    close: true,
    reopen: true,
    comment: true,
    reason: "Fixture permissions",
  },
  relatedThreads: [],
  relatedThreadsTruncated: false,
});
beforeEach(() => localStorage.clear());
function seed(app: ReturnType<typeof harness>, detail = original) {
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  for (const repo of [undefined, repository]) {
    app.daemon.workspace.setForgeRead(
      { op: "forge.issue.detail", workspaceId, repository: repo, number: 42 },
      { resource: "issueDetail", value: detail },
    );
    app.daemon.workspace.setForgeRead(
      { op: "forge.issue.list", workspaceId, repository: repo, query: ForgeIssueSearch.parse({}) },
      {
        resource: "issueList",
        value: {
          repository,
          items: [detail],
          total: 1,
          counts: { open: 1, closed: 0 },
          canCreate: true,
          unavailableReason: "",
          incomplete: false,
          truncated: false,
        },
      },
    );
  }
  for (const number of [0, 42])
    app.daemon.workspace.setForgeRead(
      { op: "forge.issue.actions", workspaceId, repository, number },
      { resource: "issueActions", actions: [] },
    );
  app.daemon.workspace.setForgeRead(
    { op: "forge.issue.timeline", workspaceId, repository, number: 42, page: 1 },
    { resource: "issueTimeline", events: [], truncated: false },
  );
}
async function edit() {
  await userEvent.click(await screen.findByRole("button", { name: "Edit issue" }));
  return screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Issue body" });
}
async function submit(name: string) {
  const button = await screen.findByRole<HTMLButtonElement>("button", { name });
  await waitFor(() => expect(button.disabled).toBe(false));
  await userEvent.click(button);
}

for (const refusal of ["unsent", "busy", "unauthorized", "invalid"] as const) {
  test(`a ${refusal} refusal releases only the submission association and preserves the draft across remount and retry`, async () => {
    const app = harness();
    seed(app);
    app.daemon.workspace.setIssueOutcome(refusal);
    await app.open("/issues?project=api&number=42");
    let comment = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "Issue comment",
    });
    await userEvent.type(comment, "Keep this unsent comment");
    await submit("Post issue comment");
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Post issue comment" }).disabled,
      ).toBe(false),
    );
    expect(comment.value).toBe("Keep this unsent comment");
    expect(screen.queryByRole("button", { name: "Check submission" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Back to issues" }));
    await userEvent.click(await screen.findByRole("button", { name: "Original issue #42" }));
    comment = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Issue comment" });
    expect(comment.value).toBe("Keep this unsent comment");
    app.daemon.workspace.setIssueOutcome("succeeded");
    await submit("Post issue comment");
    await screen.findByText("Saved on GitHub.");
    expect(comment.value).toBe("");
    expect(await screen.findAllByText("Keep this unsent comment")).toHaveLength(1);
  });
}

test("an unknown admission outcome keeps its draft submission fenced across remount", async () => {
  const app = harness();
  seed(app);
  app.daemon.workspace.setIssueOutcome("unknown");
  await app.open("/issues?project=api&number=42");
  await userEvent.type(
    await screen.findByRole("textbox", { name: "Issue comment" }),
    "Possibly submitted",
  );
  await submit("Post issue comment");
  await screen.findByRole("button", { name: "Check submission" });
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Post issue comment" }).disabled,
  ).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Back to issues" }));
  await userEvent.click(await screen.findByRole("button", { name: "Original issue #42" }));
  expect(
    (await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Issue comment" })).value,
  ).toBe("Possibly submitted");
  await screen.findByRole("button", { name: "Check submission" });
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Post issue comment" }).disabled,
  ).toBe(true);
});

test("an edit draft keeps its original version across refresh and remount until explicitly reloaded", async () => {
  const app = harness();
  seed(app);
  await app.open("/issues?project=api&number=42");
  const body = await edit();
  await userEvent.clear(body);
  await userEvent.type(body, "My old draft");
  const remote = {
    ...original,
    title: "Someone else's issue",
    body: "Someone else's description",
    updatedAt: "2026-10-11",
  };
  for (const repo of [undefined, repository])
    app.daemon.workspace.setForgeRead(
      { op: "forge.issue.detail", workspaceId, repository: repo, number: 42 },
      { resource: "issueDetail", value: remote },
    );
  await userEvent.click(screen.getByRole("button", { name: "Refresh issue" }));
  await screen.findByRole("heading", { name: /Someone else's issue #42/ });
  await userEvent.click(screen.getByRole("button", { name: "Hide editor" }));
  expect((await edit()).value).toBe("My old draft");
  await submit("Save issue");
  await screen.findByText("The GitHub resource changed while reading. Refresh before continuing.");
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Issue body" }).value).toBe(
    "My old draft",
  );
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Reload current issue" }).disabled,
    ).toBe(false),
  );
  await userEvent.click(screen.getByRole("button", { name: "Reload current issue" }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Issue body" }).value).toBe(
    "Someone else's description",
  );
  await submit("Save issue");
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Issue body" })).toBeNull());
});

test("a completed edit reopens from saved content and a later title-only change preserves its description", async () => {
  const app = harness();
  seed(app);
  await app.open("/issues?project=api&number=42");
  const body = await edit();
  await userEvent.clear(body);
  await userEvent.type(body, "Saved description");
  await submit("Save issue");
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Issue body" })).toBeNull());
  await screen.findByText("Saved description");
  expect((await edit()).value).toBe("Saved description");
  const title = screen.getByRole("textbox", { name: "Issue title" });
  await userEvent.clear(title);
  await userEvent.type(title, "Renamed issue");
  await submit("Save issue");
  await screen.findByRole("heading", { name: /Renamed issue #42/ });
  expect(await screen.findByText("Saved description")).toBeTruthy();
});

test("comment fields stop accepting edits while their durable submission is waiting", async () => {
  const storage = memoryStorage();
  const gate = Promise.withResolvers<void>();
  let holding = false;
  const app = harness({
    outbox: {
      load: () => storage.load(),
      save: async (value) => {
        if (holding) await gate.promise;
        await storage.save(value);
      },
    },
  });
  seed(app);
  await app.open("/issues?project=api&number=42");
  const comment = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Issue comment",
  });
  await userEvent.type(comment, "Submitted text");
  holding = true;
  try {
    await submit("Post issue comment");
    expect(comment.disabled).toBe(true);
    await userEvent.type(comment, "New text while waiting");
    expect(comment.value).toBe("Submitted text");
  } finally {
    holding = false;
    gate.resolve();
  }
  await screen.findByText("Saved on GitHub.");
  expect(comment.value).toBe("");
  expect(await screen.findByText("Submitted text")).toBeTruthy();
});

test("reconciling a lost comment receipt consumes the posted revision and cannot submit it again", async () => {
  const app = harness();
  seed(app);
  app.daemon.workspace.setIssueOutcome("uncertain");
  await app.open("/issues?project=api&number=42");
  const comment = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Issue comment",
  });
  await userEvent.type(comment, "Posted once");
  await submit("Post issue comment");
  await userEvent.click(await screen.findByRole("button", { name: "Reconcile action" }));
  await screen.findByText("GitHub confirmed the action.");
  expect(comment.value).toBe("");
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Post issue comment" }).disabled,
  ).toBe(true);
  expect(await screen.findAllByText("Posted once")).toHaveLength(1);
});

test("comment reconciliation preserves newer unsent text instead of clearing it with the posted revision", async () => {
  const app = harness();
  seed(app);
  app.daemon.workspace.setIssueOutcome("uncertain");
  await app.open("/issues?project=api&number=42");
  const comment = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Issue comment",
  });
  await userEvent.type(comment, "Posted once");
  await submit("Post issue comment");
  const reconcile = await screen.findByRole<HTMLButtonElement>("button", {
    name: "Reconcile action",
  });
  await waitFor(() => expect(comment.disabled).toBe(false));
  await userEvent.clear(comment);
  await userEvent.type(comment, "Next unsent comment");
  await userEvent.click(reconcile);
  await screen.findByText("GitHub confirmed the action.");
  expect(comment.value).toBe("Next unsent comment");
  expect(await screen.findAllByText("Posted once")).toHaveLength(1);
  expect(screen.queryByText("Next unsent comment", { selector: "p" })).toBeNull();
});

test("creation recovery clears the submitted draft before the next New issue editor opens", async () => {
  const app = harness();
  seed(app);
  app.daemon.workspace.setIssueOutcome("uncertain");
  await app.open("/issues?project=api");
  await userEvent.click(await screen.findByRole("button", { name: "New issue" }));
  await userEvent.type(await screen.findByRole("textbox", { name: "Issue title" }), "Created once");
  await userEvent.type(screen.getByRole("textbox", { name: "Issue body" }), "Created description");
  await submit("Create issue");
  await screen.findByRole("button", { name: "Reconcile action" });
  await userEvent.click(screen.getByRole("button", { name: "New issue" }));
  await userEvent.click(screen.getByRole("button", { name: "New issue" }));
  await userEvent.click(await screen.findByRole("button", { name: "Reconcile action" }));
  await screen.findByRole("heading", { name: /Created once #43/ });
  await userEvent.click(screen.getByRole("button", { name: "Back to issues" }));
  await userEvent.click(await screen.findByRole("button", { name: "New issue" }));
  expect(
    (await screen.findByRole<HTMLInputElement>("textbox", { name: "Issue title" })).value,
  ).toBe("");
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Issue body" }).value).toBe("");
});

test("closing an issue updates cached membership and counts before returning to the fresh open list", async () => {
  const app = harness();
  seed(app);
  await app.open("/issues?project=api");
  await userEvent.click(await screen.findByRole("button", { name: "Original issue #42" }));
  await submit("Close issue");
  await screen.findByRole("button", { name: "Reopen issue" });
  await userEvent.click(screen.getByRole("button", { name: "Back to issues" }));
  await screen.findByText("No issues match these filters.");
  expect(screen.queryByRole("button", { name: "Original issue #42" })).toBeNull();
  expect(screen.getByRole("button", { name: "Open 0" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Closed 1" })).toBeTruthy();
});
