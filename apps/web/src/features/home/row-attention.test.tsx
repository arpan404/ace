import type { Fact } from "@ace/core";
import { seedRealThreadState, workbench, type Scenario } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";

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
  /** The colour of a status word on a row's top line. */
  const tone = (title: string, text: string) =>
    word(title, text)?.closest<HTMLElement>("[data-tone]")?.dataset.tone;
  const visit = async (path: string) => act(() => history.push(path));
  // A row's status gives way to its actions under the pointer: open it, then move the pointer on.
  const open = async (title: string) => {
    await userEvent.click(link(title));
    await userEvent.unhover(link(title));
  };
  return { app, link, row, word, tone, visit, open };
}

test("a done thread says Done until it is opened, then rests quiet with only its age", async () => {
  const { link, row, word, visit, open } = await setup();
  const title = "Ship the release notes";
  await waitFor(() => expect(row(title)).toEqual({ level: "done-unread", muted: false }));
  expect(word(title, "Done")).toBeTruthy();
  expect(link(title).getAttribute("aria-label")).toContain(", unread");
  await open(title);
  await waitFor(() => expect(link(title).getAttribute("aria-current")).toBe("page"));
  await visit("/new");
  await waitFor(() => expect(row(title)).toEqual({ level: "quiet", muted: true }));
  expect(word(title, "Done")).toBeNull();
  // The title still shows; a quiet relative time takes the status word's place.
  expect(within(link(title)).getByText(title)).toBeTruthy();
  expect(within(link(title)).getByText(/^(now|\d+[smhd])$/)).toBeTruthy();
});

test("new activity after reading brings Done back", async () => {
  const { app, row, word, link, visit, open } = await setup();
  const title = "Ship the release notes";
  await open(title);
  await visit("/new");
  await waitFor(() => expect(row(title).level).toBe("quiet"));
  act(() => app.daemon.apply("thread-done", turnFacts("turn-2", "completed")));
  await waitFor(() => expect(row(title).level).toBe("done-unread"));
  expect(word(title, "Done")).toBeTruthy();
  expect(link(title).getAttribute("aria-label")).toContain(", unread");
});

test("a thread that needs you keeps saying so in the needs-you colour after it is opened", async () => {
  const { row, tone, link, visit, open } = await setup();
  const title = "Approval sheet loses its state on rotate";
  expect(row(title)).toEqual({ level: "needs-you", muted: false });
  await open(title);
  await visit("/new");
  await waitFor(() => expect(link(title).getAttribute("aria-label")).not.toContain(", unread"));
  expect(row(title)).toEqual({ level: "needs-you", muted: false });
  expect(tone(title, "Answer")).toBe("needs-you");
});

test("a failure says Failed in the failure colour until seen, then a quiet Failed", async () => {
  const { link, row, word, tone, visit, open } = await setup();
  const title = "Migrate the billing table";
  await waitFor(() => expect(row(title)).toEqual({ level: "failed", muted: false }));
  expect(tone(title, "Failed")).toBe("failed");
  await open(title);
  await visit("/new");
  await waitFor(() => expect(row(title)).toEqual({ level: "failed-seen", muted: true }));
  expect(word(title, "Failed")).toBeTruthy();
  expect(tone(title, "Failed")).toBeUndefined();
  expect(link(title).getAttribute("aria-label")).toContain("Failed");
});

test("a working row says Working with its live glyph, open or not", async () => {
  const { row, word, open } = await setup();
  const title = "Rewrite the install page for the daemon";
  const live = () =>
    word(title, "Working")?.parentElement?.querySelector('[data-state="working"][data-live]');
  expect(row(title)).toEqual({ level: "active", muted: true });
  expect(live()).toBeTruthy();
  await open(title);
  await waitFor(() => expect(row(title)).toEqual({ level: "active", muted: false }));
  expect(live()).toBeTruthy();
});

test("a waiting approval reads Approve in the needs-you colour, on its row only, and leads the Inbox", async () => {
  const app = harness();
  for (const [id, title] of [
    ["thread-asks", "Publish the release"],
    ["thread-rests", "Tidy the changelog"],
  ] as const)
    createIdleTask(app.daemon, { id, title, workspaceId: "ace", provider: "codex" });
  await app.open("/new");
  const list = within(await screen.findByRole("navigation", { name: "Threads" }));
  await list.findByRole("link", { name: /^Publish the release/ });
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
  await waitFor(() =>
    expect(
      within(asks()).getByText("Approve", { exact: true }).closest<HTMLElement>("[data-tone]")
        ?.dataset.tone,
    ).toBe("needs-you"),
  );
  // It leads the Inbox.
  const top = list.getAllByRole("link").find((link) => link.hasAttribute("data-row-focus"));
  expect(top).toBe(asks());
  // The tabs never repeat the dot, and there is no notification bell.
  expect(list.getByRole("tablist").querySelector("[data-tone='needs-you']")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Inbox/ })).toBeNull();
});

test("Mark as unread on a quiet row's menu brings Done back", async () => {
  const { app, link, row, word } = await setup();
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
  await userEvent.unhover(link(title));
  expect(word(title, "Done")).toBeTruthy();
});

test("an unsent thread says Not sent in the needs-you colour and a stopped one rests quiet", async () => {
  const app = harness();
  seedRealThreadState(app.daemon);
  await app.open("/new");
  const list = within(await screen.findByRole("navigation", { name: "Threads" }));
  const stopped = await list.findByRole("link", { name: /^Finish the background build/ });
  const unsent = await list.findByRole("link", { name: /^Check the saved message/ });
  expect(unsent.getAttribute("aria-label")).toContain("Not sent");
  expect(
    within(unsent).getByText("Not sent", { exact: true }).closest<HTMLElement>("[data-tone]")
      ?.dataset.tone,
  ).toBe("needs-you");
  expect(within(stopped).queryByText(/Stopped|Agent stopped/)).toBeNull();
  expect(
    stopped.querySelector("[data-tone='waiting'] svg, [data-tone='waiting'] [data-state]"),
  ).toBeNull();
});
