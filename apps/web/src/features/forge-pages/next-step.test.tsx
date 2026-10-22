import { seedForgeBrowse, sketchPullRequests, workbench, type PrSketch } from "@ace/fake-daemon";
import { VerifyRun, WorkspaceId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const repository = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
/** The head a sketched pull request is at (the fake catalog's rule). */
const head = (number: number) => number.toString(16).padStart(40, "e");

/** The design's world with `acme/ace`'s pull requests; Verify steps through runs at once. */
function withRepository(sketches?: PrSketch[]) {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  if (sketches) app.daemon.workspace.seedPullRequests(sketchPullRequests(Date.now(), sketches));
  else seedForgeBrowse(app.daemon, Date.now());
  app.daemon.services.verify.stepMs = 1;
  return app;
}

/** A pull request of the viewer's, approved, checks green. */
const mine = (number: number, patch: Partial<PrSketch> = {}): PrSketch => ({
  number,
  title: `Change ${number}`,
  state: "open",
  author: "you",
  reviewers: [],
  decision: "APPROVED",
  ci: "success",
  updated: number * 60_000,
  branch: `work/${number}`,
  body: "",
  files: [["src/a.ts", 1, 0]],
  ...patch,
});

const group = async (name: string) => within(await screen.findByRole("region", { name }));
const strip = () => within(screen.getByRole("status", { name: "Merge" }));

test("a pull request waiting on the viewer's review shows Review, which opens its code", async () => {
  const app = withRepository();
  await app.open("/pulls?project=ace");
  const needs = await group("Needs you");
  await userEvent.click(await needs.findByRole("button", { name: /^Review: #229 / }));
  expect(await screen.findByRole("article", { name: "Pull request #229" })).toBeTruthy();
  expect((await screen.findByRole("tab", { name: "Code" })).getAttribute("aria-selected")).toBe(
    "true",
  );
});

test("the viewer's pull request with failing checks offers Fix checks", async () => {
  const app = withRepository([mine(301, { ci: "failure" }), mine(302)]);
  await app.open("/pulls?project=ace");
  const needs = await group("Needs you");
  expect(await needs.findByRole("button", { name: /^Fix checks: #301 / })).toBeTruthy();
  expect(needs.queryByRole("button", { name: /#302/ })).toBeNull();
});

test("a failing local check moves a ready pull request to Needs you with Fix checks", async () => {
  const app = withRepository([mine(302)]);
  await app.open("/pulls?project=ace");
  const ready = await group("Ready to merge");
  expect(await ready.findByRole("button", { name: /^Merge: #302 / })).toBeTruthy();
  app.daemon.services.verify.seed(
    VerifyRun.parse({
      id: "check-302",
      workspaceId: WorkspaceId.parse("ace"),
      target: { kind: "check", pr: { pr: { repository, number: 302 }, headSha: head(302) } },
      state: "failed",
      command: "bun run check",
      steps: [],
      createdAt: 5,
      merged: [],
      revision: 3,
      failure: { code: "check_failed", message: "2 tests failed" },
    }),
  );
  const needs = await group("Needs you");
  expect(await needs.findByRole("button", { name: /^Fix checks: #302 / })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Ready to merge" })).toBeNull();
});

test("selecting two ready pull requests and pressing Start sends one merge run with both heads in list order", async () => {
  const app = withRepository();
  app.daemon.services.verify.paused = true;
  await app.open("/pulls?project=ace");
  const ready = await group("Ready to merge");
  // Picked in the other order: the run follows the list.
  await userEvent.click(await ready.findByRole("button", { name: /^Merge: #224 / }));
  await userEvent.click(ready.getByRole("button", { name: /^Merge: #233 / }));
  expect(strip().getByText("Verify and merge 2 pull requests into main")).toBeTruthy();
  await userEvent.click(strip().getByRole("button", { name: "Start" }));
  await waitFor(() =>
    expect(
      app.daemon.services.verify.started.map(({ target }) =>
        target.kind === "merge" ? target.prs.map((pr) => [pr.pr.number, pr.headSha]) : target.kind,
      ),
    ).toEqual([
      [
        [233, head(233)],
        [224, head(224)],
      ],
    ]),
  );
  expect(await strip().findByText("Fetching main, #233 and #224")).toBeTruthy();
  expect(strip().getByRole("button", { name: "Stop" })).toBeTruthy();
});

test("a conflict names both pull requests, and retrying without one merges the other", async () => {
  const app = withRepository();
  app.daemon.services.verify.outcome = () => ({ code: "conflict", pr: 224, with: 233 });
  await app.open("/pulls?project=ace");
  const ready = await group("Ready to merge");
  await userEvent.click(await ready.findByRole("button", { name: /^Merge: #233 / }));
  await userEvent.click(ready.getByRole("button", { name: /^Merge: #224 / }));
  await userEvent.click(strip().getByRole("button", { name: "Start" }));
  expect(await strip().findByText("#224 conflicts with #233")).toBeTruthy();
  await userEvent.click(strip().getByRole("button", { name: "Remove #224 and retry" }));
  expect(await strip().findByText("Merged 1 pull request")).toBeTruthy();
  const merged = app.daemon.services.verify.started[1]?.target;
  expect(merged?.kind === "merge" && merged.prs.map((pr) => pr.pr.number)).toEqual([233]);
  // What merged leaves the open list.
  await waitFor(async () =>
    expect((await group("Ready to merge")).queryByRole("button", { name: /#233/ })).toBeNull(),
  );
});

test("a project without a check command offers to set one", async () => {
  const app = withRepository();
  app.daemon.services.verify.commands.set("ace", null);
  await app.open("/pulls?project=ace");
  const ready = await group("Ready to merge");
  await userEvent.click(await ready.findByRole("button", { name: /^Merge: #224 / }));
  expect(strip().queryByRole("button", { name: "Start" })).toBeNull();
  await userEvent.click(strip().getByRole("button", { name: "Set a check command" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("textbox", { name: "Check command" })).toBeTruthy();
});

test("a pull request's local check runs from its page and counts in its checks gate", async () => {
  const app = withRepository();
  await app.open("/pulls/ace/224");
  const page = within(await screen.findByRole("article", { name: "Pull request #224" }));
  // The checks gate opens the checks.
  await userEvent.click(await page.findByRole("button", { name: "Checks: 3 passed" }));
  await userEvent.click(
    await page.findByRole("button", { name: "Local · bun run check: Not run" }),
  );
  await userEvent.click(page.getByRole("button", { name: "Run checks" }));
  expect(
    await page.findByRole("button", { name: "Local · bun run check: Passed" }, { timeout: 3_000 }),
  ).toBeTruthy();
  expect(await page.findByRole("button", { name: "Checks: 4 passed" })).toBeTruthy();
  expect(await page.findByRole("log", { name: "Log of Local · bun run check" })).toBeTruthy();
});
