import { coldStartReplay, replayTs } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openWorkCard } from "@/test/open-work.ts";
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

test("a turn's change opens inline, named as the agent's, with Keep and Comment and no Revert", async () => {
  const { app } = await reviewTurnOne();
  const peek = await peekOf();
  expect(peek.textContent).toContain("Claude Code · turn 1 · 1 of 3");
  expect(peek.textContent).toContain("const COLD_START_WINDOW = 200;");
  // The turn's lines carry the agent's mark, saying who and which turn.
  expect(within(view()).getAllByTitle("Claude Code changed this in turn 1").length).toBeGreaterThan(
    0,
  );
  expect(within(peek).getByRole("button", { name: "Keep" })).toBeTruthy();
  // Reverting a turn is the daemon's to do: the review offers no Revert, and changes nothing.
  expect(within(peek).queryByRole("button", { name: "Revert" })).toBeNull();
  expect(await bytes(app, replayTs.path)).toBe(replayTs.afterTurn2);
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

test("Side by side shows the turn's diff of the file in place of the editor, and goes back", async () => {
  await reviewTurnOne();
  await userEvent.click(within(await peekOf()).getByRole("button", { name: "Side by side" }));

  const side = await screen.findByRole("region", { name: `Side by side, ${replayTs.path}` });
  expect(side.textContent).toContain("Claude Code · turn 1 · 1 of 3");
  expect(side.textContent).toContain("const COLD_START_WINDOW = 200;");
  expect(screen.queryByRole("region", { name: `Source of ${replayTs.path}` })).toBeNull();

  await userEvent.click(within(side).getByRole("button", { name: "Back to inline" }));
  expect((await peekOf()).textContent).toContain("1 of 3");
});

test("after a line is typed above a change, Keep acts on the change at its new place", async () => {
  await reviewTurnOne();
  expect((await peekOf()).getAttribute("aria-label")).toBe("Review change at line 11");

  const field = within(view()).getByRole("textbox");
  field.focus();
  fireEvent.keyDown(field, { key: "Home", ctrlKey: true });
  fireEvent.input(field, { target: { value: "x\n" }, data: "x\n", inputType: "insertText" });
  await waitFor(async () =>
    expect((await peekOf()).getAttribute("aria-label")).toBe("Review change at line 12"),
  );

  await userEvent.click(within(await peekOf()).getByRole("button", { name: "Keep" }));
  await waitFor(async () => expect((await peekOf()).textContent).toContain("2 of 3"));
});

test("a two-file turn: keeping a file's last change moves on, and coming back finds it kept", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("root-replied");
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  // Turn 2 changed replay.ts, then outbox.ts: the Work card reviews the last turn with edits.
  const card = await openWorkCard();
  await userEvent.click(
    await within(card).findByRole("button", { name: /^Review turn 2 in editor/ }),
  );
  const peek = await peekOf();
  expect(peek.textContent).toContain("turn 2 · 1 of 1");

  // Keeping replay.ts's only change goes on to the turn's next file.
  await userEvent.click(within(peek).getByRole("button", { name: "Keep" }));
  await screen.findByRole("region", { name: "Source of apps/web/src/relay/outbox.ts" });

  // Back to replay.ts: its change was kept, so nothing waits there.
  const panel = screen.getByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("tab", { name: /replay\.ts/ }));
  await screen.findByRole("region", { name: `Source of ${replayTs.path}` });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(screen.queryByRole("group", { name: /^Review change at line/ })).toBeNull();
});
