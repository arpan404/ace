import { oneTurnWork } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const follows = (a: Element, b: Element) =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

const logs = (feed: HTMLElement) =>
  within(feed).queryAllByRole("button", { name: /^(?:Work(ed|ing) for|Work so far)/ });

test("one turn that talks between steps, finishes a background task and starts a subagent reads as one Worked for", async () => {
  const app = harness();
  const script = app.play(oneTurnWork());
  script.runThrough("answered");
  await app.open("/t/thread-one-turn");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const answer = await within(feed).findByText(/Resume dropped events because/);

  expect(logs(feed)).toHaveLength(1);
  const log = logs(feed)[0]!;
  expect(log.textContent).toMatch(/^Worked for/);
  // The log comes first; the background task, the subagents line and the answer follow it.
  const background = within(feed).getByRole("group", {
    name: "Background task OpenCode background work",
  });
  const started = within(feed).getByRole("button", { name: "Started 1 subagent" });
  expect(follows(log, background)).toBe(true);
  expect(follows(log, started)).toBe(true);
  expect(follows(log, answer)).toBe(true);
  expect(background.textContent).toContain("Finished");

  // What the agent said between steps is in the log, in order between those steps.
  expect(within(feed).queryByText(/The outbox clears its buffer/)).toBeNull();
  await userEvent.click(log);
  const steps = await within(feed).findByRole("list", { name: "Steps" });
  const interim = within(steps).getByText(/The outbox clears its buffer/);
  expect(
    follows(within(steps).getByRole("button", { name: /^Read src\/outbox.ts/ }), interim),
  ).toBe(true);
  expect(
    follows(interim, within(steps).getByRole("button", { name: /^Read src\/replay.ts/ })),
  ).toBe(true);
});

test("while the turn runs, a note followed by more work never opens a second log", async () => {
  const app = harness();
  const script = app.play(oneTurnWork());
  script.runThrough("interim");
  await app.open("/t/thread-one-turn");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  // The agent's latest words read below its log while nothing follows them yet.
  const interim = await within(feed).findByText(/The outbox clears its buffer/);
  expect(logs(feed)).toHaveLength(1);
  expect(follows(logs(feed)[0]!, interim)).toBe(true);

  // Work after it: the note moves into the same log, which carries the turn's live line.
  act(() => script.runThrough("background-done"));
  await within(feed).findByRole("button", { name: "Started 1 subagent" });
  expect(logs(feed)).toHaveLength(1);
  expect(within(feed).queryByText(/The outbox clears its buffer/)).toBeNull();
});
