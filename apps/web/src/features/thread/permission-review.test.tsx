import { permissionAudit } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

async function openAudit(path: string) {
  const app = harness();
  app.play(permissionAudit()).runThrough("escalated");
  await app.open(path);
  return app;
}

/** Opens every collapsed work log, so each step's row is on screen. */
async function openWorkLogs(feed: HTMLElement) {
  for (const header of within(feed).queryAllByRole("button", { expanded: false }))
    if (/Work(ed|ing) for/.test(header.textContent ?? "")) await userEvent.click(header);
}

test("a safe command in an outside working directory still waits for a person", async () => {
  const app = harness();
  const scenario = permissionAudit("thread-outside-review");
  const step = scenario.steps.find((candidate) => candidate.label === "approved");
  if (step?.kind !== "facts") throw new Error("Missing inspection step");
  const approval = step.facts.find((fact) => fact.type === "interaction.opened");
  if (
    approval?.type !== "interaction.opened" ||
    approval.request.kind !== "approval" ||
    !approval.request.target
  )
    throw new Error("Missing inspection target");
  approval.request.target.cwd = "/outside";
  app.play(scenario).runThrough("approved");
  await app.open("/t/thread-outside-review");
  const card = await screen.findByRole("article", { name: "Run pwd?" });
  expect(within(card).getByRole("region", { name: "ace's review" }).textContent).toContain(
    "Action reaches outside the thread workspace",
  );
  expect(within(card).getByRole("button", { name: "Allow once" })).toBeTruthy();
  expect(app.daemon.isPending("thread-outside-review", "check-cwd")).toBe(true);
});

test("each decision ace's risk policy took reads once, on the step it judged", async () => {
  await openAudit("/t/thread-release-audit");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText(/ace declined deleting dist/);
  await openWorkLogs(feed);
  expect(
    await within(feed).findByRole("button", { name: "Ran pwd Approved by ace · auto-review" }),
  ).toBeTruthy();
  const denied = within(feed).getByRole("button", {
    name: "Run rm -rf dist Denied by ace · auto-review",
  });
  // No second copy of the decision as its own note, and no raw tool name anywhere.
  expect(within(feed).queryByRole("article", { name: /Permission review/ })).toBeNull();
  expect(feed.textContent).not.toMatch(/Unknown tool|requestApproval/);

  // The review (who decided, why, on exactly what) opens under the step.
  await userEvent.click(denied);
  const review = await within(feed).findByRole("region", { name: "ace's review" });
  expect(review.textContent).toContain("Destructive command is outside the automatic risk policy");
  expect(within(review).getByText("rm -rf dist")).toBeTruthy();
  expect(within(review).getByText("ace risk policy · Auto-review")).toBeTruthy();
  expect(within(review).getAllByText("Command").length).toBeGreaterThan(0);
});

test("a request sent to the person waits on its step, then reads as their answer", async () => {
  await openAudit("/t/thread-release-audit");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await openWorkLogs(feed);
  expect(
    await within(feed).findByRole("button", {
      name: "Run npm publish --dry-run Waiting for your approval",
    }),
  ).toBeTruthy();

  const card = await screen.findByRole("article", { name: "Run npm publish --dry-run?" });
  await userEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  // The pick shows on the step at once, and stays once the daemon has it.
  expect(
    await within(feed).findByRole("button", {
      name: /^Run(ning)? npm publish --dry-run Approved by you$/,
    }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(screen.queryByRole("article", { name: "Run npm publish --dry-run?" })).toBeNull(),
  );
  expect(within(feed).queryByText("Waiting for your approval")).toBeNull();
  expect(feed.textContent).not.toContain("Sent to you");
});

test("a request ace sent on says why, in the thread and in Activity", async () => {
  const app = await openAudit("/t/thread-release-audit");
  const card = await screen.findByRole("article", { name: "Run npm publish --dry-run?" });
  const review = within(card).getByRole("region", { name: "ace's review" });
  expect(review.textContent).toContain("Command is not in the low-risk allowlist");
  expect(within(review).getByText("npm publish --dry-run")).toBeTruthy();
  // Approved and denied requests never reached a person.
  expect(screen.queryByRole("article", { name: "Run rm -rf dist?" })).toBeNull();

  // The sidebar's bell: Activity's way in.
  await userEvent.click(
    within(screen.getByRole("navigation", { name: "App" })).getByRole("link", {
      name: /^Activity/,
    }),
  );
  const inActivity = await screen.findByRole("article", { name: /npm publish --dry-run/ });
  expect(within(inActivity).getByRole("region", { name: "ace's review" }).textContent).toContain(
    "Command is not in the low-risk allowlist",
  );
  await userEvent.click(within(inActivity).getByRole("button", { name: /Approve/ }));
  await waitFor(() => expect(app.daemon.isPending("thread-release-audit", "dry-run")).toBe(false));
});
