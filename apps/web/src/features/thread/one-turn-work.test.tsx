import { oneTurnWork } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openWorkLog } from "@/test/open-work-log.ts";

beforeEach(() => localStorage.clear());

const follows = (a: Element, b: Element) =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

const logs = (feed: HTMLElement) =>
  within(feed).queryAllByRole("button", { name: /^(?:Work(ed|ing) for)/ });

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
  // The log comes first; the subagents line and the answer follow it. The finished background
  // task is the turn's work, so it folds into the log and reads there as its step.
  const started = within(feed).getByRole("button", { name: "1 subagent" });
  expect(follows(log, started)).toBe(true);
  expect(follows(log, answer)).toBe(true);
  expect(
    within(feed).queryByRole("group", { name: "Background task OpenCode background work" }),
  ).toBeNull();

  // What the agent said between steps is in the log, in order between those steps.
  expect(within(feed).queryByText(/The outbox clears its buffer/)).toBeNull();
  const steps = await openWorkLog(feed);
  const interim = within(steps).getByText(/The outbox clears its buffer/);
  expect(
    follows(within(steps).getByRole("button", { name: /^Read src\/outbox.ts/ }), interim),
  ).toBe(true);
  expect(
    follows(interim, within(steps).getByRole("button", { name: /^Read src\/replay.ts/ })),
  ).toBe(true);
  expect(within(steps).getByText(/Check the replay path/)).toBeTruthy();
});

test("while the turn runs, a note followed by more work never opens a second log", async () => {
  const app = harness();
  const script = app.play(oneTurnWork());
  script.runThrough("interim");
  await app.open("/t/thread-one-turn");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  // The agent's latest words read below its log while nothing follows them yet.
  const interim = await within(feed).findByText(/The outbox clears its buffer/);
  expect(logs(feed)).toHaveLength(0);
  expect(screen.getByRole("status", { name: "Working" })).toBeTruthy();
  expect(interim).toBeTruthy();

  // Work after it: the note stays where it was said, once, in the turn's one flow under its one
  // live header.
  act(() => script.runThrough("background-done"));
  await within(feed).findByRole("button", { name: "1 subagent" });
  expect(logs(feed)).toHaveLength(0);
  expect(within(feed).getAllByText(/The outbox clears its buffer/)).toHaveLength(1);
  expect(screen.getAllByRole("group", { name: "Turn in progress" })).toHaveLength(1);
});
