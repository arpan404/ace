import { coldStartReplay, facts } from "@ace/fake-daemon";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

async function openChanges(through = "turn-2", storage = memoryKeyValue()) {
  const app = harness({ storage });
  const script = app.play(coldStartReplay());
  script.runThrough(through);
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Meta>}{Shift>}d{/Shift}{/Meta}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  return { app, script, panel };
}
const file = (panel: HTMLElement, path: string) =>
  within(panel).getByRole("region", { name: path });
async function pickScope(panel: HTMLElement, name: string) {
  await userEvent.click(within(panel).getByRole("button", { name: /^Scope:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: new RegExp(`^${name}`) }));
}
async function pickLayout(panel: HTMLElement, name: "Auto" | "Unified" | "Split") {
  await userEvent.click(within(panel).getByRole("button", { name: /^Diff layout/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: new RegExp(`^${name}`) }));
}

test("Changes shows the latest turn's edits by default and the whole thread under All turns", async () => {
  const { panel } = await openChanges();
  expect(within(panel).getByRole("tab", { name: /Changes/ }).textContent).toContain("+");

  // Turn 2: the onResume edit and the subagent's outbox patch, not turn 1's replayFrom edit.
  await within(panel).findByRole("region", { name: "apps/server/src/replay.ts" });
  const replay = file(panel, "apps/server/src/replay.ts");
  expect(within(replay).getByText(/const \{ events, coldStart \} = replayFrom/)).toBeTruthy();
  expect(within(replay).queryByText(/COLD_START_WINDOW = 200/)).toBeNull();
  const outbox = file(panel, "apps/web/src/relay/outbox.ts");
  expect(within(outbox).getByText(/await socket.waitFor\("resume.ack"\)/)).toBeTruthy();

  await pickScope(panel, "All turns");
  await waitFor(() =>
    expect(
      within(file(panel, "apps/server/src/replay.ts")).getByText(/COLD_START_WINDOW = 200/),
    ).toBeTruthy(),
  );

  await pickScope(panel, "Turn 1");
  await waitFor(() =>
    expect(
      within(panel).queryByRole("region", { name: "apps/web/src/relay/outbox.ts" }),
    ).toBeNull(),
  );
});

test("folded unchanged lines expand, and a file collapses from its header", async () => {
  const { panel } = await openChanges();
  const replay = await within(panel).findByRole("region", { name: "apps/server/src/replay.ts" });
  expect(within(replay).queryByText(/export interface Replay/)).toBeNull();
  await userEvent.click(within(replay).getAllByRole("button", { name: /unchanged lines/ })[0]!);
  expect(within(replay).getByText(/export interface Replay/)).toBeTruthy();

  // Gaps in a provider patch have no text to show, so they are not buttons.
  const outbox = file(panel, "apps/web/src/relay/outbox.ts");
  expect(within(outbox).getByText("17 unchanged lines").tagName).not.toBe("BUTTON");

  const header = within(replay).getByRole("button", { name: /replay\.ts/, expanded: true });
  await userEvent.click(header);
  expect(header.getAttribute("aria-expanded")).toBe("false");
  expect(within(replay).queryByText(/export interface Replay/)).toBeNull();
});

test("split layout puts the removed line beside its replacement, and the choice is remembered", async () => {
  const { panel } = await openChanges();
  const replay = await within(panel).findByRole("region", { name: "apps/server/src/replay.ts" });
  await pickLayout(panel, "Split");
  const removed = within(replay).getByText(/client.send\(\{ type: "resume.ack" \}\);/);
  const row = removed.closest(".grid-cols-2");
  expect(
    row && within(row as HTMLElement).getByText(/const \{ events, coldStart \} = replayFrom/),
  ).toBeTruthy();

  await userEvent.click(within(panel).getByRole("tab", { name: "Agents" }));
  await userEvent.click(within(panel).getByRole("tab", { name: /Changes/ }));
  expect(await within(panel).findByRole("button", { name: "Diff layout: Split" })).toBeTruthy();
});

test("a line comment goes to the agent through review mode and lands in the thread", async () => {
  const { app, panel } = await openChanges();
  const replay = await within(panel).findByRole("region", { name: "apps/server/src/replay.ts" });
  const line = within(replay).getByText(/client.send\(\{ type: "resume.ack", headSeq/);
  await userEvent.hover(line);
  await userEvent.click(within(line).getByRole("button", { name: /^Comment on line \d+$/ }));
  await userEvent.type(
    within(replay).getByRole("textbox", { name: /Comment on line/ }),
    "Should the ack also carry `coldStartWindow`?",
  );
  await userEvent.click(within(replay).getByRole("button", { name: "Comment" }));

  const card = within(replay).getByRole("article", { name: /Comment on line/ });
  expect(within(card).getByText("just now", { exact: false })).toBeTruthy();
  // The identifier reads as code, as it would in the agent's own prose.
  expect(within(card).getByText("coldStartWindow").tagName).toBe("CODE");
  expect(app.daemon.review.comments()).toEqual([]);

  await userEvent.click(within(card).getByRole("button", { name: "Send to agent" }));
  await within(card).findByText("Sent to agent");
  const [held] = app.daemon.review.comments();
  expect(held).toMatchObject({
    text: "Should the ack also carry `coldStartWindow`?",
    sent: true,
    anchor: { position: { file: "apps/server/src/replay.ts", side: "new" } },
  });
  await screen.findByText(/Review comments to address:/);
});

test("a comment can be edited before it is sent, and discarded", async () => {
  const { app, panel } = await openChanges();
  const replay = await within(panel).findByRole("region", { name: "apps/server/src/replay.ts" });
  await userEvent.click(
    within(replay).getAllByRole("button", { name: /^Comment on old line \d+$/ })[0]!,
  );
  await userEvent.type(within(replay).getByRole("textbox"), "Why drop this?{Meta>}{Enter}{/Meta}");
  const card = within(replay).getByRole("article");
  await userEvent.click(within(card).getByRole("button", { name: "Edit" }));
  const box = within(replay).getByRole("textbox");
  await userEvent.clear(box);
  await userEvent.type(box, "Keep the old ack for one release.");
  await userEvent.click(within(replay).getByRole("button", { name: "Comment" }));
  expect(within(replay).getByText("Keep the old ack for one release.")).toBeTruthy();

  await userEvent.click(within(replay).getByRole("button", { name: "Discard" }));
  expect(within(replay).queryByRole("article")).toBeNull();
  expect(app.daemon.review.comments()).toEqual([]);
});

test("the diff follows the thread live as a later turn edits more files", async () => {
  const { script, panel } = await openChanges("turn-1");
  await within(panel).findByRole("region", { name: "apps/server/src/replay.ts" });
  expect(within(panel).queryByRole("region", { name: "apps/web/src/relay/outbox.ts" })).toBeNull();
  await act(async () => script.runThrough("turn-2"));
  await within(panel).findByRole("region", { name: "apps/web/src/relay/outbox.ts" });
});

test("a collapsed file stays collapsed after looking at another tab and coming back", async () => {
  const { panel } = await openChanges();
  const replay = await within(panel).findByRole("region", { name: "apps/server/src/replay.ts" });
  await userEvent.click(within(replay).getByRole("button", { name: /replay\.ts/, expanded: true }));
  await userEvent.click(within(panel).getByRole("tab", { name: /Agents/ }));
  await userEvent.click(within(panel).getByRole("tab", { name: /Changes/ }));
  const again = within(panel).getByRole("region", { name: "apps/server/src/replay.ts" });
  expect(
    within(again)
      .getByRole("button", { name: /^apps\/server\/src\/replay\.ts/ })
      .getAttribute("aria-expanded"),
  ).toBe("false");
});

test("a line comment stays on its line when the diff switches between Unified and Split", async () => {
  const { panel } = await openChanges();
  const replay = await within(panel).findByRole("region", { name: "apps/server/src/replay.ts" });
  const line = within(replay).getByText(/client.send\(\{ type: "resume.ack", headSeq/);
  await userEvent.click(within(line).getByRole("button", { name: /^Comment on line \d+$/ }));
  await userEvent.type(within(replay).getByRole("textbox"), "Carry coldStartWindow too?");
  await userEvent.click(within(replay).getByRole("button", { name: "Comment" }));
  const name = within(replay).getByRole("article").getAttribute("aria-label");

  await pickLayout(panel, "Split");
  const split = within(panel).getByRole("region", { name: "apps/server/src/replay.ts" });
  const card = within(split).getByRole("article", { name: name ?? "" });
  expect(within(card).getByText("Carry coldStartWindow too?")).toBeTruthy();

  await pickLayout(panel, "Unified");
  expect(within(panel).getByText("Carry coldStartWindow too?")).toBeTruthy();
});

test("Changes says what is uncommitted in the checkout, and follows a commit", async () => {
  const { panel } = await openChanges();
  const tree = await within(panel).findByRole("status", { name: "Working tree" });
  expect(tree.textContent).toContain("Working tree: 2 files uncommitted on fix/cold-start-cap");
  expect(tree.textContent).toContain("38 added, 6 removed");
  // The tab's own count says it is the whole thread's, not the scope's or the checkout's.
  await userEvent.hover(
    within(within(panel).getByRole("tab", { name: /Changes/ })).getByText(/^\+/),
  );
  expect(await screen.findByText(/^This thread: \+\d+ −\d+$/, {}, { timeout: 2000 })).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Commit" }));
  const dialog = await screen.findByRole("dialog", { name: "Commit changes" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Commit" }));
  await waitFor(() =>
    expect(within(panel).getByRole("status", { name: "Working tree" }).textContent).toContain(
      "Working tree: Everything is committed on fix/cold-start-cap · 1 to push",
    ),
  );
});

test("a turn that changed many files mounts only the files near the view, and lists every one", async () => {
  const { app, panel } = await openChanges("test-done");
  // jsdom applies no stylesheet: give the diff's scroller the overflow its class sets.
  const scroller = panel.querySelector<HTMLElement>("[data-diff-scroller]");
  if (scroller) scroller.style.overflowY = "auto";
  const paths = Array.from({ length: 60 }, (_, n) => `packages/fixtures/src/case-${n}.ts`);
  const [first = "", last = ""] = [paths[0], paths[59]];
  act(() =>
    app.daemon.apply("thread-cold-start", [
      facts.turn("root"),
      facts.tool("root", "edit-fixtures", {
        kind: "file.edit",
        title: "Add fixtures",
        detail: {
          kind: "file.edit",
          changes: paths.map((path, n) => ({
            path,
            kind: "add" as const,
            newText: Array.from(
              { length: 50 },
              (_, line) => `export const c${n}_${line} = ${line};`,
            )
              .join("\n")
              .concat("\n"),
          })),
        },
      }),
      facts.toolDone("root", "edit-fixtures"),
      facts.endTurn("root"),
    ]),
  );
  const tree = await within(panel).findByRole("tree", { name: "Changed files" });
  await waitFor(() =>
    expect(
      within(tree)
        .getAllByRole("treeitem")
        .filter((row) => row.getAttribute("aria-expanded") === null),
    ).toHaveLength(60),
  );
  expect(within(panel).getByRole("region", { name: first })).toBeTruthy();
  // 3,000 rows across 60 files: only the first few files are mounted.
  expect(within(panel).queryByRole("region", { name: last })).toBeNull();
  expect(within(panel).getAllByRole("region").length).toBeLessThan(20);
});

async function comment(panel: HTMLElement, path: string, line: RegExp, text: string) {
  const block = await within(panel).findByRole("region", { name: path });
  const row = within(block).getByText(line);
  await userEvent.click(within(row).getByRole("button", { name: /^Comment on line \d+$/ }));
  await userEvent.type(within(block).getByRole("textbox", { name: /Comment on line/ }), text);
  await userEvent.click(within(block).getByRole("button", { name: "Comment" }));
  return block;
}

test("unsent comments are summed up, sent together, then resolved and reopened", async () => {
  const { app, panel } = await openChanges();
  await comment(
    panel,
    "apps/server/src/replay.ts",
    /client.send\(\{ type: "resume.ack", headSeq/,
    "Carry coldStartWindow too?",
  );
  await comment(
    panel,
    "apps/web/src/relay/outbox.ts",
    /await socket.waitFor\("resume.ack"\)/,
    "Time this out after 5 s.",
  );

  const review = within(panel).getByRole("region", { name: "Review" });
  expect(within(review).getByRole("status").textContent).toBe("2 comments to send");
  await userEvent.click(within(review).getByRole("button", { name: "Send 2 comments to agent" }));

  await waitFor(() =>
    expect(within(review).getByRole("status").textContent).toBe("2 waiting for the agent"),
  );
  expect(app.daemon.review.comments().map((held) => [held.text, held.sent])).toEqual([
    ["Carry coldStartWindow too?", true],
    ["Time this out after 5 s.", true],
  ]);

  const outbox = file(panel, "apps/web/src/relay/outbox.ts");
  const card = within(outbox).getByRole("article", { name: /Comment on line/ });
  expect(within(card).getByText("Sent to agent")).toBeTruthy();
  await userEvent.click(within(card).getByRole("button", { name: "Resolve" }));
  await within(outbox).findByText("Resolved");
  await waitFor(() =>
    expect(
      app.daemon.review.comments().find((held) => held.text.startsWith("Time"))?.resolved,
    ).toBe(true),
  );
  expect(within(review).getByRole("status").textContent).toBe(
    "1 waiting for the agent · 1 resolved",
  );

  await userEvent.click(within(outbox).getByRole("button", { name: "Reopen" }));
  await within(outbox).findByRole("button", { name: "Resolve" });
  expect(app.daemon.review.comments().every((held) => !held.resolved)).toBe(true);
});

test("the review's comments list jumps to a comment's file", async () => {
  const { panel } = await openChanges();
  await comment(
    panel,
    "apps/web/src/relay/outbox.ts",
    /await socket.waitFor\("resume.ack"\)/,
    "Time this out after 5 s.",
  );
  const review = within(panel).getByRole("region", { name: "Review" });
  await userEvent.click(within(review).getByRole("button", { name: "Comments" }));
  const toSend = await screen.findByRole("group", { name: "To send" });
  await userEvent.click(within(toSend).getByRole("menuitem", { name: /outbox\.ts:\d+/ }));
  const tree = within(panel).getByRole("tree", { name: "Changed files" });
  expect(within(tree).getByRole("treeitem", { selected: true }).getAttribute("aria-label")).toMatch(
    /^apps\/web\/src\/relay\/outbox\.ts, 1 comment$/,
  );
});

test("comments and the diff layout come back after the page reloads", async () => {
  const storage = memoryKeyValue();
  const first = await openChanges("turn-2", storage);
  await comment(
    first.panel,
    "apps/server/src/replay.ts",
    /client.send\(\{ type: "resume.ack", headSeq/,
    "Carry coldStartWindow too?",
  );
  await pickLayout(first.panel, "Split");
  cleanup();

  // The workspace remembered too: the thread opens with Changes showing.
  const app = harness({ storage });
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const replay = await within(panel).findByRole("region", { name: "apps/server/src/replay.ts" });
  const card = within(replay).getByRole("article", { name: /Comment on line/ });
  expect(within(card).getByText("Carry coldStartWindow too?")).toBeTruthy();
  expect(within(card).getByRole("button", { name: "Send to agent" })).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Diff layout: Split" })).toBeTruthy();
});

test("the files tree filters, jumps to a file, and shows which files were viewed", async () => {
  const { panel } = await openChanges();
  const tree = await within(panel).findByRole("tree", { name: "Changed files" });
  await userEvent.type(
    within(panel).getByRole("searchbox", { name: "Filter changed files" }),
    "outbox",
  );
  const files = within(tree)
    .getAllByRole("treeitem")
    .filter((row) => row.getAttribute("aria-expanded") === null);
  expect(files.map((row) => row.getAttribute("aria-label"))).toEqual([
    "apps/web/src/relay/outbox.ts",
  ]);
  await userEvent.click(within(panel).getByRole("button", { name: "Clear filter" }));

  const replay = file(panel, "apps/server/src/replay.ts");
  await userEvent.click(within(replay).getByRole("button", { name: "Viewed" }));
  expect(
    within(replay)
      .getByRole("button", { name: /^apps\/server\/src\/replay\.ts/ })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(
    within(tree).getByRole("treeitem", { name: "apps/server/src/replay.ts, viewed" }),
  ).toBeTruthy();

  const outbox = within(tree).getByRole("treeitem", { name: "apps/web/src/relay/outbox.ts" });
  outbox.focus();
  await userEvent.keyboard("{Enter}");
  expect(outbox.getAttribute("aria-selected")).toBe("true");
});

test("checkout scopes the daemon can't diff yet say why instead of opening", async () => {
  const { panel } = await openChanges();
  await userEvent.click(within(panel).getByRole("button", { name: /^Scope:/ }));
  const staged = await screen.findByRole("menuitem", { name: /^Staged/ });
  expect(staged.getAttribute("aria-disabled")).toBe("true");
  expect(staged.textContent).toContain("The daemon doesn't report the git index yet");
});
