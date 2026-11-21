import { coldStartReplay, replayTs } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { bytes } from "../files/tree-test-queries.ts";

configure({ asyncUtilTimeout: 10000 });

/*
 * Review in editor, end to end on the app over the fake daemon: from a turn's changed files in
 * the transcript, the edited file opens with the turn's hunks inline, marked as the agent's in
 * the gutter, to keep, revert (put back and saved) or step through with F7.
 */

const thread = "thread-cold-start";

async function reviewTurnOne() {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  // The scenario's checkout holds the file as both turns left it.
  expect(await bytes(app, replayTs.path)).toBe(replayTs.afterTurn2);
  // Turn 1's changed files, in the transcript.
  const [button] = await screen.findAllByRole("button", { name: "Review in editor" });
  if (!button) throw new Error("no Review in editor");
  await userEvent.click(button);
  await screen.findByRole("region", { name: `Source of ${replayTs.path}` });
  return { app };
}

/** The editor as it is now: a reveal shows its line in a fresh view. */
const view = () => screen.getByRole("region", { name: `Source of ${replayTs.path}` });
const peekOf = () => screen.findByRole("group", { name: /^Review change at line/ });

test("a turn's change opens inline, named as the agent's, and Revert puts it back and saves", async () => {
  const { app } = await reviewTurnOne();
  const peek = await peekOf();
  expect(peek.textContent).toContain("Claude Code · turn 1 · 1 of 3");
  expect(peek.textContent).toContain("const COLD_START_WINDOW = 200;");
  // The turn's lines carry the agent's mark, saying who and which turn.
  expect(within(view()).getAllByTitle("Claude Code changed this in turn 1").length).toBeGreaterThan(0);

  await userEvent.click(within(peek).getByRole("button", { name: "Revert" }));

  // Only that hunk went back; turn 2's later change is still there.
  await waitFor(async () =>
    expect(await bytes(app, replayTs.path)).not.toContain("const COLD_START_WINDOW = 200;"),
  );
  const saved = await bytes(app, replayTs.path);
  expect(saved).toContain("headSeq: this.thread.headSeq, coldStart");
  // On to the next change.
  expect((await peekOf()).textContent).toContain("2 of 3");
});

test("Keep leaves the text as it is and goes on; F7 and ⇧F7 step; Done ends the review", async () => {
  const { app } = await reviewTurnOne();
  await userEvent.click(within(await peekOf()).getByRole("button", { name: "Keep" }));
  await waitFor(async () => expect((await peekOf()).textContent).toContain("2 of 3"));
  expect(await bytes(app, replayTs.path)).toBe(replayTs.afterTurn2);

  const field = () => within(view()).getByRole("textbox");
  fireEvent.keyDown(field(), { key: "F7" });
  await waitFor(async () => expect((await peekOf()).textContent).toContain("3 of 3"));
  // ⇧F7 goes back, past the kept one.
  fireEvent.keyDown(field(), { key: "F7", shiftKey: true });
  await waitFor(async () => expect((await peekOf()).textContent).toContain("2 of 3"));

  await userEvent.click(within(await peekOf()).getByRole("button", { name: "Done" }));
  expect(within(view()).queryByRole("group", { name: /^Review change/ })).toBeNull();
  expect(within(view()).queryAllByTitle("Claude Code changed this in turn 1")).toHaveLength(0);
});
