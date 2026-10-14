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
  await list.findByRole("link", { name: /^Migrate the billing table/ });
  const link = (title: string) => list.getByRole("link", { name: new RegExp(`^${title}`) });
  /** The row around a link: its attention level and whether it reads muted. */
  const row = (title: string) => {
    const element = link(title).closest<HTMLElement>("[data-attention]");
    if (!element) throw new Error(`No row for ${title}`);
    return { level: element.dataset.attention, muted: element.hasAttribute("data-muted") };
  };
  const word = (title: string, text: string) =>
    within(link(title)).queryByText(text, { exact: true });
  const visit = async (path: string) => act(() => history.push(path));
  return { app, list, link, row, word, visit };
}

test("a done thread says Done until it is opened, then goes quiet with only its age", async () => {
  const { link, row, word, visit } = await setup();
  await waitFor(() => expect(word("Ship the release notes", "Done")).toBeTruthy());
  expect(row("Ship the release notes")).toEqual({ level: "done-unread", muted: false });
  await userEvent.click(link("Ship the release notes"));
  await waitFor(() =>
    expect(link("Ship the release notes").getAttribute("aria-current")).toBe("page"),
  );
  await visit("/new");
  await waitFor(() =>
    expect(row("Ship the release notes")).toEqual({ level: "quiet", muted: true }),
  );
  expect(word("Ship the release notes", "Done")).toBeNull();
  // The title still shows; a quiet relative time takes the status word's place.
  expect(within(link("Ship the release notes")).getByText("Ship the release notes")).toBeTruthy();
  expect(within(link("Ship the release notes")).getByText(/^(now|\d+[smhd])$/)).toBeTruthy();
});

test("new activity after reading makes a thread unread again", async () => {
  const { app, link, row, word, visit } = await setup();
  await userEvent.click(link("Ship the release notes"));
  await visit("/new");
  await waitFor(() => expect(row("Ship the release notes").level).toBe("quiet"));
  act(() => app.daemon.apply("thread-done", turnFacts("turn-2", "completed")));
  await waitFor(() => expect(row("Ship the release notes").level).toBe("done-unread"));
  expect(word("Ship the release notes", "Done")).toBeTruthy();
  expect(link("Ship the release notes").getAttribute("aria-label")).toContain(", unread");
});

test("a thread that needs you stays strong after it is opened", async () => {
  const { link, row, word, visit } = await setup();
  const title = "Approval sheet loses its state on rotate";
  expect(row(title)).toEqual({ level: "needs-you", muted: false });
  await userEvent.click(link(title));
  await visit("/new");
  await waitFor(() => expect(link(title).getAttribute("aria-label")).not.toContain(", unread"));
  expect(row(title)).toEqual({ level: "needs-you", muted: false });
  expect(word(title, "Answer")).toBeTruthy();
});

test("a failure is strong until seen, then a quiet Failed", async () => {
  const { link, row, word, visit } = await setup();
  const title = "Migrate the billing table";
  await waitFor(() => expect(row(title)).toEqual({ level: "failed", muted: false }));
  expect(word(title, "Failed")).toBeTruthy();
  await userEvent.click(link(title));
  await visit("/new");
  await waitFor(() => expect(row(title)).toEqual({ level: "failed-seen", muted: true }));
  expect(word(title, "Failed")).toBeTruthy();
});

test("a working row that isn't open is calm with a live indicator; the open one is full contrast", async () => {
  const { link, row, word } = await setup();
  const title = "Rewrite the install page for the daemon";
  expect(row(title)).toEqual({ level: "active", muted: true });
  const status = word(title, "Working")?.parentElement;
  expect(status?.querySelector('[data-state="working"][data-live]')).toBeTruthy();
  await userEvent.click(link(title));
  await waitFor(() => expect(row(title)).toEqual({ level: "active", muted: false }));
  expect(
    word(title, "Working")?.parentElement?.querySelector('[data-state="working"][data-live]'),
  ).toBeTruthy();
});

test("Mark as unread brings Done back, and Mark as read quiets it, from the row's menu", async () => {
  const { app, row, word } = await setup();
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
  expect(word(title, "Done")).toBeTruthy();
});

test("the sidebar row and Activity give the same thread the same word and colour", async () => {
  const history = createMemoryHistory({ initialEntries: ["/activity"] });
  const app = harness({ history });
  seedRealThreadState(app.daemon);
  await app.open("/activity");
  const activity = await screen.findByRole("complementary", { name: "Activity" });
  const pairs = [
    ["Check the saved message", "Not sent"],
    ["Finish the background build", "Stopped by a restart"],
  ] as const;
  const fromActivity = new Map<string, string | undefined>();
  for (const [title, label] of pairs) {
    const [entry] = await within(activity).findAllByRole("link", { name: `${title}: ${label}` });
    if (!entry) throw new Error(`No Activity row for ${title}`);
    fromActivity.set(
      title,
      within(entry).getByText(label).closest<HTMLElement>("[data-tone]")?.dataset.tone,
    );
  }
  expect(fromActivity.get("Check the saved message")).toBe("needs-you");
  await act(() => history.push("/new"));
  const list = within(await screen.findByRole("navigation", { name: "Threads" }));
  for (const [title, label] of pairs) {
    const link = await list.findByRole("link", { name: new RegExp(`^${title}`) });
    const tone = within(link).getByText(label).closest<HTMLElement>("[data-tone]")?.dataset.tone;
    expect(tone).toBe(fromActivity.get(title));
  }
});
