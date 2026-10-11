import { beforeEach, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgeIssueDetail, ForgeIssueSearch, WorkspaceId } from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
const repository = { forge: "github", host: "github.com", owner: "acme", name: "api" } as const;
const detail = ForgeIssueDetail.parse({
  ref: { repository, number: 42 },
  title: "Keep issue context",
  url: "https://github.com/acme/api/issues/42",
  author: "author",
  state: "open",
  labels: ["bug"],
  assignees: ["maintainer"],
  milestone: "Release",
  createdAt: "2026-10-10",
  updatedAt: "2026-10-10",
  body: "## Original context\n\nPreserve issue ordering.",
  permissions: {
    edit: false,
    close: false,
    reopen: false,
    comment: true,
    reason: "Your gh account cannot edit this issue.",
  },
  relatedThreads: [],
  relatedThreadsTruncated: false,
});
beforeEach(() => localStorage.clear());
function seed(app: ReturnType<typeof harness>) {
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.setForgeRead(
    { op: "forge.issue.detail", workspaceId: WorkspaceId.parse("api"), number: 42 },
    { resource: "issueDetail", value: detail },
  );
  app.daemon.workspace.setForgeRead(
    {
      op: "forge.issue.timeline",
      workspaceId: WorkspaceId.parse("api"),
      repository,
      number: 42,
      page: 1,
    },
    {
      resource: "issueTimeline",
      events: [
        {
          id: "comment",
          kind: "issue_comment",
          event: "commented",
          actor: "reviewer",
          at: "2026-10-10",
          body: "**Issue discussion**",
          raw: {},
        },
      ],
      truncated: false,
    },
  );
  app.daemon.workspace.setForgeRead(
    { op: "forge.issue.actions", workspaceId: WorkspaceId.parse("api"), repository, number: 42 },
    { resource: "issueActions", actions: [] },
  );
}
test("an issue opens independently of an agent task and returning retains repository filters", async () => {
  const app = harness();
  seed(app);
  const query = ForgeIssueSearch.parse({ labels: ["bug"], assignee: "maintainer", page: 2 });
  app.daemon.workspace.setForgeRead(
    { op: "forge.issue.list", workspaceId: WorkspaceId.parse("api"), query },
    {
      resource: "issueList",
      value: {
        repository,
        items: [detail],
        total: 26,
        nextPage: 3,
        counts: { open: 26, closed: 2 },
        canCreate: true,
        unavailableReason: "",
        incomplete: false,
        truncated: false,
      },
    },
  );
  await app.open("/issues?project=api&labels=%5B%22bug%22%5D&assignee=maintainer&page=2");
  await userEvent.click(await screen.findByRole("button", { name: "Keep issue context #42" }));
  expect(await screen.findByText("Preserve issue ordering.")).toBeTruthy();
  expect(await screen.findByText("Issue discussion")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit issue" }).hasAttribute("disabled")).toBe(true);
  expect(
    screen.getByRole("link", { name: "Start task from issue" }).getAttribute("href"),
  ).toContain("issue=");
  await userEvent.click(screen.getByRole("button", { name: "Back to issues" }));
  expect(await screen.findByText("26 issues · Page 2")).toBeTruthy();
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Issue labels" }).value).toBe("bug");
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Issue assignee" }).value).toBe(
    "maintainer",
  );
});
test("an unsent issue comment survives leaving and returning while another repository cannot show the old issue", async () => {
  const app = harness();
  seed(app);
  await app.open("/issues?project=api&number=42");
  const comment = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Issue comment",
  });
  await userEvent.type(comment, "Keep my unsent draft");
  await userEvent.type(
    screen.getByRole("textbox", { name: "Issue URL or number" }),
    "https://github.com/acme/web/issues/42",
  );
  await userEvent.click(screen.getByRole("button", { name: "Open issue" }));
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Keep issue context #42" })).toBeNull(),
  );
  const address = screen.getByRole("textbox", { name: "Issue URL or number" });
  await userEvent.clear(address);
  await userEvent.type(address, "https://github.com/acme/api/issues/42");
  app.daemon.workspace.setForgeRead(
    { op: "forge.issue.detail", workspaceId: WorkspaceId.parse("api"), repository, number: 42 },
    { resource: "issueDetail", value: detail },
  );
  await userEvent.click(screen.getByRole("button", { name: "Open issue" }));
  expect(
    (await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Issue comment" })).value,
  ).toBe("Keep my unsent draft");
});
