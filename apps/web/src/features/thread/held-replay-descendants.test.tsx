import { delegatedQuestion, delegatedQuestionIds } from "@ace/fake-daemon";
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { answerStore } from "@/features/thread/interactions/answers.ts";
import { slowReplay } from "@/test/held-replay.ts";
import { harness } from "@/test/harness.tsx";

/*
 * A delegated child's request in the parent's strip is found through the parent's copy (its
 * `askingThreads` hint). While that copy is catching up after a reconnect, the hint may name a
 * request that has ended: the strip says nobody needs you from it, even with the child current.
 */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());
afterEach(() => answerStore.forgetAll());

const { parent, child } = delegatedQuestionIds;

test("a child's request found through a parent's copy that is catching up says nobody needs you, until the parent is current", async () => {
  const app = harness();
  const replay = slowReplay(app.daemon);
  for (const scenario of delegatedQuestion()) app.play(scenario).runUntilBlocked();
  await app.open(`/t/${parent}`);
  const region = await screen.findByRole("region", { name: "Waiting for you" });
  await within(region).findByRole("article", {
    name: "Should the review include the archived blog posts?",
  });

  // Connected again with only the parent's replay held; meanwhile the child's request ends on
  // another device. The child's own copy catches up and has nothing open.
  await replay.hold(app.client, { threads: [parent] });
  act(() =>
    app.daemon.apply(child, [
      { type: "interaction.closed", interaction: "pages", state: "resolved" },
    ]),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("article", { name: "Should the review include the archived blog posts?" }),
    ).toBeNull(),
  );
  expect(screen.queryByText("general assistant needs you")).toBeNull();

  replay.release(app.client);
  await waitFor(() => expect(app.client.peekThread?.(parent)?.syncing).toBe(false));
});
