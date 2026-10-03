import { coldStartReplay } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

async function openChanges(through = "turn-2") {
  const app = harness();
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

  await userEvent.click(within(panel).getByRole("combobox", { name: "Turn" }));
  await userEvent.click(await screen.findByRole("option", { name: "All turns" }));
  await waitFor(() =>
    expect(
      within(file(panel, "apps/server/src/replay.ts")).getByText(/COLD_START_WINDOW = 200/),
    ).toBeTruthy(),
  );

  await userEvent.click(within(panel).getByRole("combobox", { name: "Turn" }));
  await userEvent.click(await screen.findByRole("option", { name: "Turn 1" }));
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
  await userEvent.click(within(panel).getByRole("button", { name: "Split" }));
  const removed = within(replay).getByText(/client.send\(\{ type: "resume.ack" \}\);/);
  const row = removed.closest(".grid-cols-2");
  expect(
    row && within(row as HTMLElement).getByText(/const \{ events, coldStart \} = replayFrom/),
  ).toBeTruthy();

  await userEvent.click(within(panel).getByRole("tab", { name: "Agents" }));
  await userEvent.click(within(panel).getByRole("tab", { name: /Changes/ }));
  expect(
    (await within(panel).findByRole("button", { name: "Split" })).getAttribute("aria-pressed"),
  ).toBe("true");
});

test("a line comment goes to the agent through review mode and lands in the thread", async () => {
  const { app, panel } = await openChanges();
  const replay = await within(panel).findByRole("region", { name: "apps/server/src/replay.ts" });
  const line = within(replay).getByText(/client.send\(\{ type: "resume.ack", headSeq/);
  await userEvent.hover(line);
  await userEvent.click(within(line).getByRole("button", { name: /^Comment on line \d+$/ }));
  await userEvent.type(
    within(replay).getByRole("textbox", { name: /Comment on line/ }),
    "Should the ack also carry coldStartWindow?",
  );
  await userEvent.click(within(replay).getByRole("button", { name: "Comment" }));

  const card = within(replay).getByRole("article", { name: /Comment on line/ });
  expect(within(card).getByText("just now", { exact: false })).toBeTruthy();
  expect(app.daemon.review.comments()).toEqual([]);

  await userEvent.click(within(card).getByRole("button", { name: "Send to agent" }));
  await within(card).findByText("Sent to agent");
  const [held] = app.daemon.review.comments();
  expect(held).toMatchObject({
    text: "Should the ack also carry coldStartWindow?",
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
