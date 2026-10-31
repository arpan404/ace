import type { Fact } from "@ace/core";
import { seedRealThreadState, workbench, type Scenario } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/** One finished turn on its own thread: "completed" ends Done, "failed" ends Failed. */
function finished(id: string, title: string, outcome: "completed" | "failed"): Scenario {
  return {
    thread: { id, workspaceId: "ace", title, provider: "codex" },
    steps: [{ kind: "facts", facts: turnFacts("turn-1", outcome) }],
  };
}

function turnFacts(turn: string, outcome: "completed" | "failed"): Fact[] {
  return [
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      native: { provider: "codex", nativeId: "root" },
      cwd: "/Users/dev/acme",
    },
    { type: "turn.started", agent: "root", nativeTurnId: turn, trigger: "user" },
    {
      type: "item.upsert",
      agent: "root",
      item: `${turn}-ask`,
      draft: {
        type: "message",
        role: "user",
        complete: true,
        parts: [{ type: "text", text: "Go." }],
      },
    },
    {
      type: "item.upsert",
      agent: "root",
      item: `${turn}-reply`,
      draft: {
        type: "message",
        role: "assistant",
        complete: true,
        parts: [{ type: "text", text: "Ok." }],
      },
    },
    { type: "turn.ended", agent: "root", nativeTurnId: turn, outcome },
  ];
}

const named = (title: string) => ({ name: new RegExp(`^${title}`) });
/** A row's attention level and whether it reads muted. */
const level = (element: HTMLElement) => {
  const row = element.closest<HTMLElement>("[data-attention]");
  if (!row) throw new Error("No row");
  return { level: row.dataset.attention, muted: row.hasAttribute("data-muted") };
};
const says = (element: HTMLElement, text: string) =>
  within(element).queryByText(text, { exact: true });

/** A thread's row in the Inbox, opening the Inbox first. */
const inbox = async (title: string) => {
  if (!screen.queryByRole("dialog", { name: "Inbox" }))
    await userEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
  const dialog = await screen.findByRole("dialog", { name: "Inbox" });
  return within(dialog).findByRole("link", named(title));
};

/** Open a thread from its Inbox row, which closes the Inbox. */
const openFromInbox = async (title: string) => {
  await userEvent.click(await inbox(title));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Inbox" })).toBeNull());
};

async function setup() {
  const history = createMemoryHistory({ initialEntries: ["/new"] });
  // The daemon's clock runs a little ahead of this device's first launch, so its results are
  // news here rather than history from before the device joined.
  let at = Date.now() + 60_000;
  const app = harness({ history, clock: () => (at = Math.max(at + 1, Date.now() + 60_000)) });
  // A few threads, so the virtual list draws every row.
  const kept = new Set([
    "Approval sheet loses its state on rotate",
    "Rewrite the install page for the daemon",
  ]);
  for (const scenario of workbench().filter((entry) => kept.has(entry.thread.title)))
    app.play(scenario).runUntilBlocked();
  app.play(finished("thread-done", "Ship the release notes", "completed")).runUntilBlocked();
  app.play(finished("thread-failed", "Migrate the billing table", "failed")).runUntilBlocked();
  await app.open("/new");
  const list = within(await screen.findByRole("navigation", { name: "Threads" }));
  await list.findByRole("link", { name: /^Rewrite the install page/ });
  /** A thread's row in its project. */
  const link = (title: string) => list.getByRole("link", named(title));
  const inProject = (title: string) => list.queryByRole("link", named(title));
  const row = (title: string) => level(link(title));
  const word = (title: string, text: string) => says(link(title), text);
  const visit = async (path: string) => act(() => history.push(path));
  // A row's status gives way to its actions under the pointer: open it, then move the pointer on.
  const open = async (title: string) => {
    await userEvent.click(link(title));
    await userEvent.unhover(link(title));
  };
  return { app, link, inProject, row, word, visit, open };
}

test("a done thread says Done in the Inbox until it is opened, then rests quiet in its project with only its age", async () => {
  const { link, inProject, row, word, visit } = await setup();
  const title = "Ship the release notes";
  expect(inProject(title)).toBeNull();
  await waitFor(async () => expect(says(await inbox(title), "Done")).toBeTruthy());
  expect(level(await inbox(title))).toEqual({ level: "done-unread", muted: false });
  await openFromInbox(title);
  await waitFor(() => expect(link(title).getAttribute("aria-current")).toBe("page"));
  await visit("/new");
  await waitFor(() => expect(row(title)).toEqual({ level: "quiet", muted: true }));
  expect(word(title, "Done")).toBeNull();
  // The title still shows; a quiet relative time takes the status word's place.
  expect(within(link(title)).getByText(title)).toBeTruthy();
  expect(within(link(title)).getByText(/^(now|\d+[smhd])$/)).toBeTruthy();
});

test("new activity after reading sends a thread back to the Inbox as unread", async () => {
  const { app, inProject, row, visit } = await setup();
  const title = "Ship the release notes";
  await openFromInbox(title);
  await visit("/new");
  await waitFor(() => expect(row(title).level).toBe("quiet"));
  act(() => app.daemon.apply("thread-done", turnFacts("turn-2", "completed")));
  await waitFor(() => expect(inProject(title)).toBeNull());
  const back = await inbox(title);
  expect(level(back).level).toBe("done-unread");
  expect(says(back, "Done")).toBeTruthy();
  expect(back.getAttribute("aria-label")).toContain(", unread");
});

test("a thread that needs you stays strong in the Inbox after it is opened", async () => {
  const { inProject, visit } = await setup();
  const title = "Approval sheet loses its state on rotate";
  expect(level(await inbox(title))).toEqual({ level: "needs-you", muted: false });
  await openFromInbox(title);
  await visit("/new");
  await waitFor(async () =>
    expect((await inbox(title)).getAttribute("aria-label")).not.toContain(", unread"),
  );
  const seen = await inbox(title);
  expect(level(seen)).toEqual({ level: "needs-you", muted: false });
  expect(says(seen, "Answer")).toBeTruthy();
  expect(inProject(title)).toBeNull();
});

test("a failure is strong in the Inbox until seen, then a quiet Failed in its project", async () => {
  const { row, word, visit } = await setup();
  const title = "Migrate the billing table";
  await waitFor(async () =>
    expect(level(await inbox(title))).toEqual({ level: "failed", muted: false }),
  );
  expect(says(await inbox(title), "Failed")).toBeTruthy();
  await openFromInbox(title);
  await visit("/new");
  await waitFor(() => expect(row(title)).toEqual({ level: "failed-seen", muted: true }));
  expect(word(title, "Failed")).toBeTruthy();
});

test("a working row that isn't open is calm with a live indicator; the open one is full contrast", async () => {
  const { row, word, open } = await setup();
  const title = "Rewrite the install page for the daemon";
  expect(row(title)).toEqual({ level: "active", muted: true });
  const status = word(title, "Working")?.parentElement;
  expect(status?.querySelector('[data-state="working"][data-live]')).toBeTruthy();
  await open(title);
  await waitFor(() => expect(row(title)).toEqual({ level: "active", muted: false }));
  expect(
    word(title, "Working")?.parentElement?.querySelector('[data-state="working"][data-live]'),
  ).toBeTruthy();
});

test("Mark as unread on a quiet row's menu sends it back to the Inbox as Done", async () => {
  const { app, inProject, row } = await setup();
  const title = "Ship the release notes";
  await act(() =>
    app.client.command({
      type: "thread.read",
      threadId: ThreadId.parse("thread-done"),
      unread: false,
    }),
  );
  await waitFor(() => expect(row(title).level).toBe("quiet"));
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${title}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /Mark (as )?unread/ }));
  await waitFor(() => expect(inProject(title)).toBeNull());
  const unread = await inbox(title);
  expect(level(unread).level).toBe("done-unread");
  expect(says(unread, "Done")).toBeTruthy();
});

test("an unsent thread waits loudly in the Inbox and a stopped one rests quiet in its project", async () => {
  const app = harness();
  seedRealThreadState(app.daemon);
  await app.open("/new");
  const list = within(await screen.findByRole("navigation", { name: "Threads" }));
  const stopped = await list.findByRole("link", { name: /^Finish the background build/ });
  expect(list.queryByRole("link", { name: /^Check the saved message/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
  const panel = within(await screen.findByRole("dialog", { name: "Inbox" }));
  const unsent = await panel.findByRole("link", { name: /^Check the saved message/ });
  expect(
    within(unsent).getByText("Not sent").closest<HTMLElement>("[data-tone]")?.dataset.tone,
  ).toBe("needs-you");
  expect(within(stopped).queryByText(/Stopped|Agent stopped/)).toBeNull();
  expect(
    stopped.querySelector("[data-tone='waiting'] svg, [data-tone='waiting'] [data-state]"),
  ).toBeNull();
});
