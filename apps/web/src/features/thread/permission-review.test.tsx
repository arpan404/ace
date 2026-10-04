import { permissionAudit } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

async function openAudit(path: string) {
  const app = harness();
  app.play(permissionAudit()).runUntilBlocked();
  await app.open(path);
  return app;
}

test("the transcript records each decision ace's risk policy took, and why", async () => {
  await openAudit("/t/thread-release-audit");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const approved = await within(feed).findByRole("article", {
    name: "Permission review: Approved by ace",
  });
  expect(approved.textContent).toContain("Read-only workspace inspection command");
  const denied = within(feed).getByRole("article", { name: "Permission review: Denied by ace" });
  expect(denied.textContent).toContain("Destructive command is outside the automatic risk policy");
  expect(
    within(feed).getByRole("article", { name: "Permission review: Sent to you" }).textContent,
  ).toContain("Command is not in the low-risk allowlist");

  // The exact target it judged opens under the decision.
  await userEvent.click(within(denied).getByRole("button", { expanded: false }));
  expect(within(denied).getByText("rm -rf dist")).toBeTruthy();
  expect(within(denied).getByText("/Users/dev/relay")).toBeTruthy();
  expect(within(denied).getByText("ace risk policy · Auto-review")).toBeTruthy();
});

test("a request sent to the person shows the needs-you dot only until it is answered", async () => {
  await openAudit("/t/thread-release-audit");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const sent = await within(feed).findByRole("article", {
    name: "Permission review: Sent to you",
  });
  expect(within(sent).getByRole("img", { name: "Waiting for you" })).toBeTruthy();

  const card = await screen.findByRole("article", { name: "Run npm publish --dry-run?" });
  await userEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    expect(within(sent).queryByRole("img", { name: "Waiting for you" })).toBeNull(),
  );
  expect(sent.textContent).toContain("Sent to you");
});

test("a request ace sent on says why, in the thread and in Activity", async () => {
  const app = await openAudit("/t/thread-release-audit");
  const card = await screen.findByRole("article", { name: "Run npm publish --dry-run?" });
  const review = within(card).getByRole("region", { name: "ace's review" });
  expect(review.textContent).toContain("Command is not in the low-risk allowlist");
  expect(within(review).getByText("npm publish --dry-run")).toBeTruthy();
  // Approved and denied requests never reached a person.
  expect(screen.queryByRole("article", { name: "Run rm -rf dist?" })).toBeNull();

  await userEvent.click(screen.getByRole("link", { name: /Activity/ }));
  const inActivity = await screen.findByRole("article", { name: /npm publish --dry-run/ });
  expect(within(inActivity).getByRole("region", { name: "ace's review" }).textContent).toContain(
    "Command is not in the low-risk allowlist",
  );
  await userEvent.click(within(inActivity).getByRole("button", { name: /Approve/ }));
  await waitFor(() => expect(app.daemon.isPending("thread-release-audit", "dry-run")).toBe(false));
});
