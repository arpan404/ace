import { coldStartReplay } from "@ace/fake-daemon";
import { Command, ThreadId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const threadId = ThreadId.parse("thread-cold-start");
const path = "apps/server/src/replay.ts";

async function openChanges() {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await screen.findByRole("button", { name: "Right panel" }, { timeout: 10000 });
  await userEvent.keyboard("{Meta>}{Shift>}d{/Shift}{/Meta}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const replay = await within(panel).findByRole("region", { name: path });
  let serial = 0;
  const remote = (payload: unknown) =>
    app.daemon.command(
      Command.parse({ id: `remote-${++serial}`, deviceId: "other-device", payload }),
    );
  return { app, panel, replay, remote };
}

/** Two new-side lines next to each other in the file's diff: their code cells. */
function adjacentNewLines(block: HTMLElement): [HTMLElement, HTMLElement, number] {
  const cells = [...block.querySelectorAll<HTMLElement>('[data-side="new"][data-line]')];
  for (const cell of cells) {
    const line = Number(cell.dataset.line);
    const next = cells.find((other) => Number(other.dataset.line) === line + 1);
    if (next) return [cell, next, line];
  }
  throw new Error("No adjacent new lines");
}

async function readFile(app: ReturnType<typeof harness>, file: string) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of app.client.downloadFile({
    threadId,
    op: "download",
    path: file,
    offset: 0,
  }))
    chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
}

test("dragging from a line's + across the next line comments on both, and the daemon gets the range", async () => {
  const { app, replay } = await openChanges();
  const [first, second, line] = adjacentNewLines(replay);
  const plus = within(first).getByRole("button", { name: `Comment on line ${line}` });
  await userEvent.pointer([
    { keys: "[MouseLeft>]", target: plus },
    { target: second },
    { keys: "[/MouseLeft]", target: second },
  ]);
  const box = await within(replay).findByRole("textbox", {
    name: `Comment on lines ${line}–${line + 1}`,
  });
  await userEvent.type(box, "Both of these need the window");
  await userEvent.click(within(replay).getByRole("button", { name: "Comment" }));
  const card = within(replay).getByRole("article", {
    name: `Comment on lines ${line}–${line + 1}`,
  });
  await userEvent.click(within(card).getByRole("button", { name: "Send to agent" }));
  await within(card).findByText("Sent to agent");
  expect(app.daemon.review.comments()[0]?.anchor.position).toEqual({
    file: path,
    side: "new",
    start: line,
    end: line + 1,
  });
});

test("a suggested change applies to the thread's checkout and resolves its comment", async () => {
  const { app, replay } = await openChanges();
  const [cell, , line] = adjacentNewLines(replay);
  await userEvent.click(within(cell).getByRole("button", { name: `Comment on line ${line}` }));
  await userEvent.type(
    within(replay).getByRole("textbox", { name: `Comment on line ${line}` }),
    "Name the window",
  );
  await userEvent.click(within(replay).getByRole("button", { name: "Suggest change" }));
  const suggestion = within(replay).getByRole("textbox", { name: "Suggested change" });
  // It starts from what the line reads now.
  expect((suggestion as HTMLTextAreaElement).value.trim()).toBe(
    cell.textContent?.replace(/^[+−]/, "").trim(),
  );
  await userEvent.clear(suggestion);
  await userEvent.type(suggestion, "const window = COLD_START_WINDOW;");
  await userEvent.click(within(replay).getByRole("button", { name: "Comment" }));

  const card = within(replay).getByRole("article", { name: `Comment on line ${line}` });
  expect(within(card).getByLabelText("Suggested change").textContent).toBe(
    "const window = COLD_START_WINDOW;",
  );
  await userEvent.click(within(card).getByRole("button", { name: "Apply" }));
  await within(replay).findByText("Applied");
  expect((await readFile(app, path)).split("\n")[line - 1]).toBe(
    "const window = COLD_START_WINDOW;",
  );
  expect(app.daemon.review.comments()[0]).toMatchObject({ resolved: true, sent: false });
});

test("a comment from another device shows with its replies, and a reply here reaches the daemon", async () => {
  const { remote, panel, replay } = await openChanges();
  const [, , line] = adjacentNewLines(replay);
  const opened = remote({
    type: "review.open",
    source: {
      workspaceId: "ace",
      threadId,
      from: { kind: "commit", ref: "HEAD" },
      to: { kind: "working-tree" },
    },
  });
  const sessionId = opened.review?.session?.id;
  const added = remote({
    type: "review.comment",
    sessionId,
    position: { file: path, side: "new", start: line, end: line },
    text: "From my phone",
  });
  const commentId = added.review?.comment?.id;
  remote({ type: "review.reply", sessionId, commentId, text: "The agent agreed" });

  await userEvent.click(within(panel).getByRole("button", { name: "Diff options" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Refresh comments" }));
  const card = await within(panel).findByRole("article", { name: `Comment on line ${line}` });
  const replies = await within(card).findByRole("list", { name: "Replies" });
  expect(replies.textContent).toBe("The agent agreed");

  await userEvent.type(within(card).getByRole("textbox", { name: "Reply" }), "Thanks{Enter}");
  await waitFor(() => expect(within(replies).getAllByRole("listitem")).toHaveLength(2));
  expect(
    remote({ type: "review.list", sessionId, commentId, cursor: "", limit: 20 }).review?.replies,
  ).toEqual([
    expect.objectContaining({ text: "The agent agreed" }),
    expect.objectContaining({ text: "Thanks" }),
  ]);
});

test("Approve marks the thread's review approved for every device", async () => {
  const { panel, remote, replay } = await openChanges();
  expect(within(panel).queryByRole("region", { name: "Review" })).toBeNull();
  const [cell, , line] = adjacentNewLines(replay);
  await userEvent.click(within(cell).getByRole("button", { name: `Comment on line ${line}` }));
  await userEvent.type(
    within(replay).getByRole("textbox", { name: `Comment on line ${line}` }),
    "Looks good",
  );
  await userEvent.click(within(replay).getByRole("button", { name: "Comment" }));
  const review = await within(panel).findByRole("region", { name: "Review" });
  await userEvent.click(within(review).getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(within(review).getByRole("status").textContent).toMatch(/^Approved/));
  expect(remote({ type: "review.list", threadId, cursor: "", limit: 20 }).review?.sessions).toEqual(
    [expect.objectContaining({ status: "approved" })],
  );
});

test("Request changes sends the unsent comments to the agent as a queued turn", async () => {
  const { app, panel, replay } = await openChanges();
  const [cell, , line] = adjacentNewLines(replay);
  await userEvent.click(within(cell).getByRole("button", { name: `Comment on line ${line}` }));
  await userEvent.type(
    within(replay).getByRole("textbox", { name: `Comment on line ${line}` }),
    "Cap it at 200",
  );
  await userEvent.click(within(replay).getByRole("button", { name: "Comment" }));
  const review = within(panel).getByRole("region", { name: "Review" });
  await userEvent.click(within(review).getByRole("button", { name: "Request changes" }));
  await waitFor(() =>
    expect(within(review).getByRole("status").textContent).toBe("1 waiting for the agent"),
  );
  expect(app.daemon.review.comments()).toEqual([
    expect.objectContaining({ text: "Cap it at 200", sent: true }),
  ]);
  await screen.findByText(/Review comments to address:/);
});

test("Send to agent says in plain words when the agent is unavailable", async () => {
  const { app, replay } = await openChanges();
  app.daemon.refuseCommands("review_executor_unavailable", "review.sendToAgent");
  const [cell, , line] = adjacentNewLines(replay);
  await userEvent.click(within(cell).getByRole("button", { name: `Comment on line ${line}` }));
  await userEvent.type(
    within(replay).getByRole("textbox", { name: `Comment on line ${line}` }),
    "Check this",
  );
  await userEvent.click(within(replay).getByRole("button", { name: "Comment" }));
  const card = within(replay).getByRole("article", { name: `Comment on line ${line}` });
  await userEvent.click(within(card).getByRole("button", { name: "Send to agent" }));
  const alert = await within(card).findByRole("alert");
  expect(alert.textContent).toBe(
    "Couldn't send. The agent is unavailable on this daemon: start the daemon with its engine, then retry.",
  );
  expect(within(card).getByRole("button", { name: "Retry" })).toBeTruthy();
});
