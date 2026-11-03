import { longIssueReads, seedForgeBrowse, seedLongIssue, workbench } from "@ace/fake-daemon";
import { WorkspaceId, type ForgeIssueDetail } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const now = Date.now();
function withLongIssue() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  seedForgeBrowse(app.daemon, now);
  seedLongIssue(app.daemon, now);
  return app;
}
const issueOp = {
  op: "forge.issue.detail" as const,
  workspaceId: WorkspaceId.parse("ace"),
  number: 250,
};
const seeded = (() => {
  const read = longIssueReads(now).detail;
  if (read.resource !== "issueDetail") throw new Error("No issue.");
  return read.value;
})();
/** Someone else changes the issue on GitHub while the page is open. */
function elsewhere(app: ReturnType<typeof harness>, patch: Partial<ForgeIssueDetail>) {
  app.daemon.workspace.setForgeRead(issueOp, {
    resource: "issueDetail",
    value: { ...seeded, updatedAt: new Date(now + 60_000).toISOString(), ...patch },
  });
}

test("a long issue opens on its newest comments, and earlier ones load on request", async () => {
  const app = withLongIssue();
  await app.open("/issues/ace/250");
  const page = await screen.findByRole("article", { name: "Issue #250" });
  expect(await within(page).findByText(/Newest: the fix in #229 looks right/)).toBeTruthy();
  expect(within(page).queryByText("Still seeing it on the latest build. (1)")).toBeNull();
  await userEvent.click(
    await within(page).findByRole("button", { name: "Show 42 earlier comments" }),
  );
  await userEvent.click(
    await within(page).findByRole("button", { name: "Show 21 earlier comments" }),
  );
  expect(await within(page).findByText("Still seeing it on the latest build. (1)")).toBeTruthy();
  expect(within(page).queryByRole("button", { name: /earlier/ })).toBeNull();
});

test("closing an issue someone commented on since it opened closes it, without a conflict", async () => {
  const app = withLongIssue();
  await app.open("/issues/ace/250");
  const page = await screen.findByRole("article", { name: "Issue #250" });
  await within(page).findByText("Open");
  elsewhere(app, { commentCount: (seeded.commentCount ?? 0) + 1 });
  await userEvent.click(within(page).getByRole("button", { name: "Close as not planned" }));
  expect(await within(page).findByText("Closed as not planned")).toBeTruthy();
  expect(screen.queryByText("Couldn't change the issue")).toBeNull();
});

test("a title saved after someone else edited the description keeps their description", async () => {
  const app = withLongIssue();
  await app.open("/issues/ace/250");
  const page = await screen.findByRole("article", { name: "Issue #250" });
  await userEvent.click(await within(page).findByRole("button", { name: "Edit title" }));
  elsewhere(app, { body: "Their newer description." });
  const title = within(page).getByRole("textbox", { name: "Title" });
  await userEvent.clear(title);
  await userEvent.type(title, "Back off between reconnects{Enter}");
  expect(
    await within(page).findByRole("heading", { name: /Back off between reconnects/ }),
  ).toBeTruthy();
  expect(await within(page).findByText("Their newer description.")).toBeTruthy();
});

test("labels picked in About are added to the issue when the list closes", async () => {
  const app = withLongIssue();
  await app.open("/issues/ace/250");
  const page = await screen.findByRole("article", { name: "Issue #250" });
  const about = await within(page).findByRole("region", { name: "About" });
  await userEvent.click(within(about).getByRole("button", { name: "Labels" }));
  const list = await screen.findByRole("dialog", { name: "Labels" });
  await userEvent.click(await within(list).findByRole("button", { name: /^web/ }));
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(within(about).getByRole("button", { name: "Labels" }).textContent).toContain(
      "bug, providers, web",
    ),
  );
});
