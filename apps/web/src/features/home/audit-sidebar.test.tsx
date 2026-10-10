import { facts, workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { Profiler } from "react";
import { publishStartedTitles, useStartedTitle } from "./started-titles.ts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";
import { resetDismissed } from "@/lib/dismissed-sends.ts";

const originalMedia = globalThis.matchMedia;
beforeEach(() => {
  resetDismissed();
});
afterEach(() => {
  globalThis.matchMedia = originalMedia;
  vi.restoreAllMocks();
  publishStartedTitles(new Map());
});
function app(options: Parameters<typeof harness>[0] = {}) {
  const made = harness(options);
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  return made;
}
const nav = () => screen.getByRole("navigation", { name: "Threads" });
const row = (name: RegExp) => within(nav()).getByRole("link", { name });
function narrow() {
  globalThis.matchMedia = (query) => ({
    matches: query.includes("max-width") || query.includes("max-width: 48rem"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
}
async function rename(link: HTMLElement) {
  await userEvent.pointer({ keys: "[MouseRight]", target: link });
  await userEvent.click(await screen.findByRole("menuitem", { name: /Rename/ }));
  return screen.findByRole("textbox", { name: "Thread title" });
}

test("a refused send shows Not sent in both the sidebar and its spoken name", async () => {
  const made = app();
  made.daemon.refuseCommands("model_unavailable", "thread.send");
  await made.open("/t/thread-dedupe");
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Keep this message{Enter}",
  );
  await screen.findByRole("button", { name: "Retry" });
  await waitFor(() => expect(row(/^Dedupe.*Not sent/)).toBeTruthy());
  expect(within(row(/^Dedupe/)).getByText("Not sent")).toBeTruthy();
  await userEvent.click(screen.getByRole("link", { name: "New thread" }));
  expect(within(row(/^Dedupe/)).getByText("Not sent")).toBeTruthy();
});

test("the palette finds other projects and their threads while the sidebar is filtered", async () => {
  const storage = memoryKeyValue();
  storage.setItem(
    "ace.home.organizer",
    JSON.stringify({ project: "relay", baseline: 0, settledOpen: false }),
  );
  await app({ storage }).open("/new?project=relay");
  await screen.findByRole("button", { name: "Project filter: relay" });
  await userEvent.keyboard("{Meta>}k{/Meta}");
  const commands = await screen.findByRole("combobox", { name: "Search commands" });
  await userEvent.type(commands, "Partial refunds");
  expect(
    await screen.findByRole("option", { name: /Partial refunds double-count tax/ }),
  ).toBeTruthy();
  await userEvent.clear(commands);
  await userEvent.type(commands, "billing-api");
  expect(await screen.findByRole("option", { name: /^billing-api/ })).toBeTruthy();
});

test("a remembered project filter is applied before the first sidebar request", async () => {
  const storage = memoryKeyValue();
  storage.setItem(
    "ace.home.organizer",
    JSON.stringify({ project: "relay", baseline: 0, settledOpen: false }),
  );
  const made = app({ storage });
  const received: string[][] = [];
  const stop = made.client.onMessage((message) => {
    if (message.type === "snapshot" && message.view.kind === "threads")
      received.push(Object.values(message.view.threads).map((thread) => thread.workspaceId));
  });
  await made.open("/new?project=relay");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  stop();
  expect(received.length).toBeGreaterThan(0);
  expect(received.flat().every((project) => project === "relay")).toBe(true);
});

test("a narrow thread marks its activity read and remembers the thread with the sidebar closed", async () => {
  narrow();
  const made = app();
  await made.client.start();
  await made.client.command({
    type: "thread.read",
    threadId: ThreadId.parse("thread-fan-out"),
    unread: true,
  });
  await made.open("/t/thread-fan-out");
  await screen.findByRole("heading", { level: 1, name: "Backpressure on broadcast fan-out" });
  await waitFor(() => {
    const snapshot = made.daemon.snapshot({ kind: "threads" });
    expect(snapshot?.kind === "threads" && snapshot.threads["thread-fan-out"]?.unread).toBe(false);
  });
  expect(made.storage.getItem("ace.home.lastThread")).toBe('"thread-fan-out"');
  expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull();
});

test("opening a thread without activity metadata does not repeatedly append read events", async () => {
  const made = app();
  const snapshot = made.daemon.snapshot.bind(made.daemon);
  made.daemon.snapshot = (scope) => {
    const view = snapshot(scope);
    if (view?.kind === "threads")
      for (const thread of Object.values(view.threads))
        Reflect.deleteProperty(thread, "activityAt");
    if (view?.kind === "thread") Reflect.deleteProperty(view.thread, "activityAt");
    return view;
  };
  const id = ThreadId.parse("thread-dedupe");
  const receive = made.daemon.command.bind(made.daemon);
  let reads = 0;
  made.daemon.command = (command) => {
    // Bound the broken feedback loop so a failing test can finish and inspect its events.
    if (command.payload.type === "thread.read" && ++reads > 2)
      made.daemon.refuseCommands("unavailable", "thread.read");
    return receive(command);
  };
  const before = made.daemon.head;
  await made.open("/t/thread-dedupe");
  await screen.findByRole("combobox", { name: "Message" });
  await made.client.command({ type: "thread.rename", threadId: id, title: "Still read" });
  await act(async () => {});
  const events = made.daemon.replay({ kind: "thread", threadId: id }, before);
  expect(
    events.filter(
      (event) =>
        event.payload.type === "thread.client.updated" && event.payload.changes.unread === false,
    ),
  ).toHaveLength(1);
});

test("a filtered empty state names the project rather than its opaque id", async () => {
  const storage = memoryKeyValue();
  const project = {
    id: "6e9edc66-5a90-40da-9ed6-b7b5eaf2d0a8",
    name: "Ledger",
    path: "/synthetic/ledger",
  };
  storage.setItem(
    "ace.home.organizer",
    JSON.stringify({ project: project.id, baseline: 0, settledOpen: false }),
  );
  const made = harness({ storage });
  made.daemon.createThread({
    id: "ledger-seed",
    workspaceId: project.id,
    title: "Archived seed",
    provider: "codex",
    details: { workspace: project },
  });
  await made.client.start();
  await made.client.command({ type: "thread.archive", threadId: ThreadId.parse("ledger-seed") });
  await made.open("/new");
  expect(await screen.findByText("Nothing in Ledger")).toBeTruthy();
  expect(screen.queryByText(`Nothing in ${project.id}`)).toBeNull();
});

test("a thread without a model or branch keeps readable provider context on its third line", async () => {
  const made = harness();
  createIdleTask(made.daemon, {
    id: "bare",
    title: "Bare thread",
    workspaceId: "relay",
    provider: "codex",
  });
  await made.open("/new");
  const bare = await within(await screen.findByRole("navigation", { name: "Threads" })).findByRole(
    "link",
    { name: /^Bare thread/ },
  );
  expect(within(bare).getByText("Codex")).toBeTruthy();
  expect(within(nav()).queryByRole("img", { name: "Codex" })).toBeNull();
});

test("composition Enter leaves rename open and Escape preserves the existing multi-selection", async () => {
  await app().open("/new");
  const first = await within(await screen.findByRole("navigation", { name: "Threads" })).findByRole(
    "link",
    { name: /^Approval sheet/ },
  );
  fireEvent.click(first, { metaKey: true });
  const title = await rename(row(/^Approval sheet/));
  await userEvent.clear(title);
  await userEvent.type(title, "候補");
  fireEvent.keyDown(title, { key: "Enter", keyCode: 229, isComposing: false });
  expect(screen.getByRole("textbox", { name: "Thread title" })).toBe(title);
  fireEvent.keyDown(title, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "Thread title" })).toBeNull();
  expect(screen.getByRole("toolbar", { name: "Selected threads" })).toBeTruthy();
  row(/^Approval sheet/).focus();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("toolbar", { name: "Selected threads" })).toBeNull();
});

test("a rename survives changing from a task row to a settled row", async () => {
  const made = app();
  createIdleTask(made.daemon, {
    id: "rename-row",
    title: "Rename across settlement",
    workspaceId: "relay",
    provider: "codex",
  });
  await made.open("/new");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findByRole("link", {
    name: /^Rename across/,
  });
  await userEvent.click(screen.getByRole("button", { name: /^Settled / }));
  const title = await rename(row(/^Rename across/));
  await userEvent.clear(title);
  await userEvent.type(title, "Retained rename");
  await act(() =>
    made.client.command({ type: "thread.settle", threadId: ThreadId.parse("rename-row") }),
  );
  const retained = await screen.findByRole<HTMLInputElement>("textbox", { name: "Thread title" });
  expect(retained.value).toBe("Retained rename");
  fireEvent.keyDown(retained, { key: "Enter" });
  expect(await within(nav()).findByRole("link", { name: /^Retained rename/ })).toBeTruthy();
});

test("Shift-click selects a range in the narrow sheet without closing it", async () => {
  narrow();
  await app().open("/t/thread-dedupe");
  await userEvent.click(await screen.findByRole("button", { name: "Back to threads" }));
  const sheet = await screen.findByRole("dialog", { name: "Sidebar" });
  const rows = within(sheet);
  const first = await rows.findByRole("link", { name: /^Approval sheet/ });
  fireEvent.click(first, { metaKey: true });
  fireEvent.click(rows.getByRole("link", { name: /^Retry budget/ }), { shiftKey: true });
  expect(screen.getByRole("dialog", { name: "Sidebar" })).toBe(sheet);
  expect(rows.getByText("2 selected")).toBeTruthy();
});

test("streaming execution changes do not reread every row's read cursor", async () => {
  const made = harness();
  createIdleTask(made.daemon, {
    id: "read-storm",
    title: "Cursor changes without rereads",
    workspaceId: "relay",
    provider: "codex",
  });
  const read = vi.spyOn(made.client, "threadReadState");
  await made.open("/new");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(0));
  const before = read.mock.calls.length;
  act(() => made.daemon.apply("read-storm", [facts.turn("root")]));
  await waitFor(() => expect(row(/^Cursor changes without rereads.*Working/)).toBeTruthy());
  expect(read.mock.calls.length).toBe(before);
});

function Title() {
  return <span>{useStartedTitle("observed")}</span>;
}

test("an unrelated provisional title does not render the observed row again", () => {
  publishStartedTitles(new Map([["observed", "My new thread"]]));
  let commits = 0;
  render(
    <Profiler
      id="observed"
      onRender={() => {
        commits++;
      }}
    >
      <Title />
    </Profiler>,
  );
  const before = commits;
  act(() =>
    publishStartedTitles(
      new Map([
        ["observed", "My new thread"],
        ["other", "Another thread"],
      ]),
    ),
  );
  expect(screen.getByText("My new thread")).toBeTruthy();
  expect(commits).toBe(before);
  act(() => publishStartedTitles(new Map([["observed", "My renamed thread"]])));
  expect(screen.getByText("My renamed thread")).toBeTruthy();
  expect(commits).toBeGreaterThan(before);
});

test("palette text matching ignores opaque thread identifiers", async () => {
  const made = app();
  createIdleTask(made.daemon, {
    id: "7c31ecdb-ab8b-44c5",
    title: "A readable thread name",
    workspaceId: "relay",
    provider: "codex",
  });
  await made.open("/new");
  await userEvent.keyboard("{Meta>}k{/Meta}");
  const commands = await screen.findByRole("combobox", { name: "Search commands" });
  await userEvent.type(commands, "7c31ecdb");
  expect(screen.queryByRole("option", { name: /A readable thread name/ })).toBeNull();
  await userEvent.clear(commands);
  await userEvent.type(commands, "readable thread");
  expect(await screen.findByRole("option", { name: /A readable thread name/ })).toBeTruthy();
});
