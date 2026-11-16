import { facts, queuedDelegation, queuedDelegationIds } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { slowReplay } from "@/test/held-replay.ts";
import { harness } from "@/test/harness.tsx";

/*
 * A subagent's row and its details after a reconnect's welcome and before the replay lands:
 * nothing live in its second line, no Review, no queue place, only the stale wording.
 */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

test("connected again but not caught up: a subagent waiting on the person says nothing of it and offers no Review", async () => {
  const app = harness();
  const replay = slowReplay(app.daemon);
  app.daemon.createThread({
    id: "review",
    workspaceId: "relay",
    provider: "claude",
    title: "Review",
  });
  app.daemon.apply("review", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.tool("root", "spawn-reviewer", {
      kind: "agent.spawn",
      title: "Review the changes",
      detail: { kind: "agent.spawn", description: "Review the diff", childAgent: "reviewer" },
    }),
    facts.subagent("claude", "reviewer", "Reviewer", "spawn-reviewer"),
    facts.turn("reviewer", "spawn"),
    {
      type: "interaction.opened",
      agent: "reviewer",
      interaction: "allow-read",
      blocking: true,
      request: {
        kind: "approval",
        title: "Read the secrets file?",
        options: [
          { id: "allow", label: "Allow once", kind: "allow_once" },
          { id: "deny", label: "Deny", kind: "deny" },
        ],
      },
    },
  ]);
  await app.open("/t/review");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const row = await within(feed).findByRole("link", { name: /^Open Reviewer, / });
  const item = row.closest("li") ?? row;
  await waitFor(() => expect(item.textContent).toContain("Waiting for you"));
  expect(
    within(item as HTMLElement).getByRole("link", { name: /^Review what Reviewer needs/ }),
  ).toBeTruthy();

  await replay.hold(app.client);
  await waitFor(() => expect(item.textContent).not.toContain("Waiting for you"));
  expect(item.textContent).toContain("Syncing…");
  expect(
    within(item as HTMLElement).queryByRole("link", { name: /^Review what Reviewer needs/ }),
  ).toBeNull();
  await userEvent.hover(within(feed).getByRole("link", { name: /^Open Reviewer, / }));
  const details = await screen.findByLabelText("Details for Reviewer");
  expect(details.textContent).not.toContain("Waiting for you");

  replay.release(app.client);
  await waitFor(() => expect(item.textContent).toContain("Waiting for you"));
});

test("connected again but not caught up: a queued child's row names no queue place or slot count", async () => {
  const app = harness();
  const replay = slowReplay(app.daemon);
  for (const scenario of queuedDelegation()) app.play(scenario).runUntilBlocked();
  await app.open(`/t/${queuedDelegationIds.parent}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const queued = /run slots in use|in line|Starts when a running agent finishes/;
  // Its rows sit in the group's fold: open it.
  const fold = await within(feed).findByRole("button", { name: /^2 subagents/ });
  if (fold.getAttribute("aria-expanded") !== "true") await userEvent.click(fold);
  await waitFor(() => expect(feed.textContent).toMatch(queued));

  await replay.hold(app.client);
  await waitFor(() => expect(feed.textContent).not.toMatch(queued));
  const row = within(feed).getByRole("link", { name: /Clean-iOS-model-picker/ });
  await userEvent.hover(row);
  const details = await screen.findByLabelText(/^Details for Clean-iOS-model-picker/);
  expect(details.textContent).not.toMatch(queued);

  replay.release(app.client);
  await waitFor(() => expect(feed.textContent).toMatch(queued));
});
