import { coldStartReplay, facts, replayCursor } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

test("between steps of an open turn the work log says Working for, without a second Working line", async () => {
  const app = harness();
  const script = app.play(replayCursor());
  script.runThrough("worked");
  await app.open("/t/thread-replay-cursor");
  const feed = await screen.findByRole("feed", { name: "Transcript" });

  expect(await within(feed).findByRole("button", { name: /^Working for/ })).toBeTruthy();
  expect(screen.queryByRole("status", { name: "Working" })).toBeNull();

  // An answer alone cannot freeze an open turn's elapsed time.
  act(() => script.runThrough("answered"));
  expect(await within(feed).findByRole("button", { name: /^Work so far/ })).toBeTruthy();
  act(() => app.daemon.apply("thread-replay-cursor", [facts.endTurn("root")]));
  expect(await within(feed).findByRole("button", { name: /^Worked for/ })).toBeTruthy();
});

test("one turn's work reads as one Worked line and one Started line, though subagents interleave", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("relay-output");
  await app.open("/t/thread-cold-start");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const second = await within(feed).findByText(/Send coldStart with the ack/);
  await within(feed).findByRole("button", { name: "Started 2 subagents" });

  // After the second ask: the parent's edit, the audit's edit and the test run are one log,
  // still open while the root waits on its subagents.
  const after = (element: Element) =>
    second.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING;
  const work = within(feed)
    .getAllByRole("button", { name: /^(?:Work(ed|ing) for|Work so far)/ })
    .filter(after);
  expect(work).toHaveLength(1);
  expect(within(feed).getAllByRole("button", { name: /^Started \d subagents?$/ })).toHaveLength(1);
  expect(within(feed).queryByRole("button", { name: "Started 1 subagent" })).toBeNull();
});
