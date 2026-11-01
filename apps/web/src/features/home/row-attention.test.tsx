import type { Fact } from "@ace/core";
import { seedRealThreadState, workbench, type Scenario } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";
import { rowText } from "@/test/row-text.ts";

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
  /** A thread's row in the list. */
  const link = (title: string) => list.getByRole("link", named(title));
  const row = (title: string) => level(link(title));
  const word = (title: string, text: string) => says(link(title), text);
  /** The one mark at the row's right edge (`RowIndicator`), by kind. */
  const mark = (title: string) =>
    link(title).querySelector<HTMLElement>("[data-indicator]")?.dataset.indicator;
  const visit = async (path: string) => act(() => history.push(path));
  // A row's status gives way to its actions under the pointer: open it, then move the pointer on.
  const open = async (title: string) => {
    await userEvent.click(link(title));
    await userEvent.unhover(link(title));
  };
  return { app, link, row, word, mark, visit, open };
}

test("a done thread carries the blue dot until it is opened, then rests quiet, its title alone", async () => {
  const { link, row, word, mark, visit, open } = await setup();
  const title = "Ship the release notes";
  await waitFor(() => expect(row(title)).toEqual({ level: "done-unread", muted: false }));
  expect(mark(title)).toBe("unread");
  expect(link(title).getAttribute("aria-label")).toContain(", unread");
  await open(title);
  await waitFor(() => expect(link(title).getAttribute("aria-current")).toBe("page"));
  await visit("/new");
  await waitFor(() => expect(row(title)).toEqual({ level: "quiet", muted: true }));
  expect(word(title, "Done")).toBeNull();
  // Seen, it carries no mark: only its title shows.
  expect(rowText(link(title))).toBe(title);
  expect(mark(title)).toBeUndefined();
});

test("new activity after reading brings back the blue dot", async () => {
  const { app, row, mark, link, visit, open } = await setup();
  const title = "Ship the release notes";
  await open(title);
  await visit("/new");
  await waitFor(() => expect(row(title).level).toBe("quiet"));
  act(() => app.daemon.apply("thread-done", turnFacts("turn-2", "completed")));
  await waitFor(() => expect(row(title).level).toBe("done-unread"));
  expect(mark(title)).toBe("unread");
  expect(link(title).getAttribute("aria-label")).toContain(", unread");
});

test("a thread that needs you keeps its needs-you mark after it is opened", async () => {
  const { row, mark, link, visit, open } = await setup();
  const title = "Approval sheet loses its state on rotate";
  expect(row(title)).toEqual({ level: "needs-you", muted: false });
  await open(title);
  await visit("/new");
  await waitFor(() => expect(link(title).getAttribute("aria-label")).not.toContain(", unread"));
  expect(row(title)).toEqual({ level: "needs-you", muted: false });
  expect(mark(title)).toBe("needs-you");
});

test("a failure carries the failure dot until seen, then rests quiet, saying Failed only in its name", async () => {
  const { link, row, word, mark, visit, open } = await setup();
  const title = "Migrate the billing table";
  await waitFor(() => expect(row(title)).toEqual({ level: "failed", muted: false }));
  expect(mark(title)).toBe("failed");
  await open(title);
  await visit("/new");
  await waitFor(() => expect(row(title)).toEqual({ level: "failed-seen", muted: true }));
  expect(word(title, "Failed")).toBeNull();
  expect(mark(title)).toBeUndefined();
  expect(link(title).getAttribute("aria-label")).toContain("Failed");
});

test("a working row shows the live mark, never a word, open or not", async () => {
  const { row, word, mark, open } = await setup();
  const title = "Rewrite the install page for the daemon";
  expect(row(title)).toEqual({ level: "active", muted: true });
  expect(mark(title)).toBe("live");
  expect(word(title, "Working")).toBeNull();
  await open(title);
  await waitFor(() => expect(row(title)).toEqual({ level: "active", muted: false }));
  expect(mark(title)).toBe("live");
});

test("a request shows the needs-you dot rather than a word, on its row only, and leads Active", async () => {
  const app = harness();
  for (const [id, title] of [
    ["thread-asks", "Publish the release"],
    ["thread-rests", "Tidy the changelog"],
  ] as const)
    createIdleTask(app.daemon, { id, title, workspaceId: "ace", provider: "codex" });
  await app.open("/new");
  const list = within(await screen.findByRole("navigation", { name: "Threads" }));
  await list.findByRole("link", { name: /^Publish the release/ });
  const project = () => list.getByRole("button", { name: /^ace/ });
  act(() =>
    app.daemon.apply("thread-asks", [
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "ask",
        blocking: true,
        request: {
          kind: "approval",
          title: "Publish?",
          options: [{ id: "allow", label: "Approve", kind: "allow_once" }],
        },
      },
    ]),
  );
  const asks = () => list.getByRole("link", { name: /^Publish the release/ });
  await waitFor(() => expect(asks().querySelector("[data-tone='needs-you']")).toBeTruthy());
  expect(within(asks()).queryByText("Approve")).toBeNull();
  // It leads Active.
  const top = list.getAllByRole("link").find((link) => link.hasAttribute("data-row-focus"));
  expect(top).toBe(asks());
  // The project never repeats the dot, and there is no Inbox bell.
  expect(project().querySelector("[data-tone='needs-you']")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Inbox/ })).toBeNull();
});

test("Mark as unread on a quiet row's menu brings back its blue dot", async () => {
  const { app, row, mark } = await setup();
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
  await waitFor(() => expect(row(title).level).toBe("done-unread"));
  expect(mark(title)).toBe("unread");
});

test("an unsent thread carries the needs-you mark and a stopped one rests quiet", async () => {
  const app = harness();
  seedRealThreadState(app.daemon);
  await app.open("/new");
  const list = within(await screen.findByRole("navigation", { name: "Threads" }));
  const stopped = await list.findByRole("link", { name: /^Finish the background build/ });
  const unsent = await list.findByRole("link", { name: /^Check the saved message/ });
  expect(unsent.getAttribute("aria-label")).toContain("Not sent");
  expect(unsent.querySelector<HTMLElement>("[data-indicator]")?.dataset.tone).toBe("needs-you");
  expect(within(stopped).queryByText(/Stopped|Agent stopped/)).toBeNull();
  expect(
    stopped.querySelector("[data-tone='waiting'] svg, [data-tone='waiting'] [data-state]"),
  ).toBeNull();
});
