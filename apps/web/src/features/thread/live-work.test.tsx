import { coldStartReplay, facts, replayCursor } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

test("between steps an open turn keeps its log and the transcript live line", async () => {
  const app = harness();
  const script = app.play(replayCursor());
  script.runThrough("worked");
  await app.open("/t/thread-replay-cursor");
  const feed = await screen.findByRole("feed", { name: "Transcript" });

  expect(within(feed).queryByText("Work so far")).toBeNull();
  expect(screen.getByRole("status", { name: "Working" }).textContent).toMatch(/^Working for/);

  // An answer alone does not close the open turn.
  act(() => script.runThrough("answered"));
  expect(within(feed).queryByText("Work so far")).toBeNull();
  act(() => app.daemon.apply("thread-replay-cursor", [facts.endTurn("root")]));
  expect(await within(feed).findByRole("button", { name: /^Worked for/ })).toBeTruthy();
});

test("one turn's work reads as one Worked line and one subagent card, though subagents interleave", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("relay-output");
  await app.open("/t/thread-cold-start");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const second = await within(feed).findByText(/Send coldStart with the ack/);
  await within(feed).findByRole("button", { name: "2 subagents" });

  expect(screen.getByRole("group", { name: "Turn in progress" }).textContent).toContain(
    "subagents",
  );
  expect(within(feed).getAllByRole("button", { name: /^\d subagents?$/ })).toHaveLength(1);
  expect(within(feed).queryByRole("button", { name: "1 subagent" })).toBeNull();
  expect(second).toBeTruthy();
});
