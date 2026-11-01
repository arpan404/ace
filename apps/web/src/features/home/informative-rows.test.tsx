import {
  facts,
  askingQuestion,
  waitingOnSubagents,
  watchingRelay,
  runningTests,
} from "@ace/fake-daemon";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { rowText } from "@/test/row-text.ts";

function task(app: ReturnType<typeof harness>, id: string, title: string) {
  app.daemon.createThread({
    id,
    title,
    workspaceId: "ace",
    provider: "codex",
    details: {
      branch: "fix/replay",
      linkedPr: { number: 283, state: "open", draft: true },
      diff: { files: 2, additions: 24, deletions: 6 },
    },
  });
  app.daemon.apply(id, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Fix replay"),
  ]);
}
const rows = async () => within(await screen.findByRole("list", { name: "Threads" }));
/** The one mark at a row's right edge (`RowIndicator`), by kind. */
const mark = (row: HTMLElement) =>
  row.querySelector<HTMLElement>("[data-indicator]")?.dataset.indicator;

/** The tone of a row's one mark: `needs-you` for what waits on the person. */
const tone = (row: HTMLElement) => row.querySelector<HTMLElement>("[data-indicator]")?.dataset.tone;

/** A thread's row in Active, which leads with what waits on the person. */
async function activeRow(title: string) {
  return (await rows()).findByRole("link", { name: new RegExp(`^${title}`) });
}

test("a plan review carries the needs-you mark and explains the request to screen readers", async () => {
  const app = harness();
  task(app, "plan", "Review reconnect recovery");
  app.daemon.apply("plan", [
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "review",
      blocking: true,
      request: { kind: "plan_review", markdown: "Review the reconnect plan" },
    },
  ]);
  await app.open("/new");
  const row = await activeRow("Review reconnect recovery");
  await waitFor(() => expect(tone(row)).toBe("needs-you"));
  expect(row.getAttribute("aria-label")).toContain("Waiting for your review");
});

test("a question carries the needs-you mark and keeps the full explanation for screen readers", async () => {
  const app = harness();
  const example = askingQuestion();
  app.play(example).runUntilBlocked();
  await app.open("/new");
  const row = await activeRow(example.thread.title);
  await waitFor(() => expect(tone(row)).toBe("needs-you"));
  expect(row.getAttribute("aria-label")).toContain("Waiting for your answer");
});

test.each([
  [waitingOnSubagents, "Waiting", "Waiting for 2 subagents"],
  [watchingRelay, "Background · 1", "Running in background bun run dev:relay"],
  [runningTests, "Working", "Working · running tests"],
])(
  "a live row shows its title and the live mark, its status in words in its name and hover card: %s",
  async (scenario, short, full) => {
    const app = harness();
    const example = scenario();
    app.play(example).runUntilBlocked();
    await app.open("/new");
    const row = await (
      await rows()
    ).findByRole("link", { name: new RegExp(`^${example.thread.title}`) });
    expect(rowText(row)).toBe(example.thread.title);
    expect(mark(row)).toBe("live");
    expect(row.getAttribute("aria-label")).toContain(full);
    await userEvent.hover(row);
    const card = await screen.findByLabelText(/^Details for /);
    expect(card.textContent).toContain(example.thread.title);
    expect(card.textContent).toContain(short);
  },
);

test("a row is its title alone: status, branch, pull request and provider are in its name and hover card", async () => {
  const app = harness();
  task(app, "build", "Build replay recovery");
  await app.open("/new");
  const row = await (await rows()).findByRole("link", { name: /^Build replay recovery/ });
  expect(rowText(row)).toBe("Build replay recovery");
  expect(within(row).queryByText("Working")).toBeNull();
  expect(within(row).queryByTitle("fix/replay")).toBeNull();
  expect(within(row).queryByRole("img", { name: "draft pull request #283" })).toBeNull();
  expect(within(row).queryByRole("img", { name: "Codex" })).toBeNull();
  for (const said of ["Working", "Codex", "fix/replay", "Pull request #283"])
    expect(row.getAttribute("aria-label")).toContain(said);
  await userEvent.hover(row);
  const tip = await screen.findByLabelText(/^Details for /);
  expect(tip.textContent).toContain("Build replay recovery");
  expect(within(tip).getByRole("img", { name: "draft pull request #283" })).toBeTruthy();
  expect(within(tip).getByRole("img", { name: "24 lines added, 6 lines removed" })).toBeTruthy();
});

test("new activity under a working tree reads unread, yet the row shows the live mark, never the finished dot", async () => {
  const app = harness();
  task(app, "build", "Build replay recovery");
  app.daemon.markReadThrough("build", "ask", "test-device");
  app.daemon.apply("build", [
    facts.subagent("codex", "web", "Web", "spawn"),
    facts.turn("web", "spawn"),
  ]);
  await app.open("/new");
  const row = await (await rows()).findByRole("link", { name: /^Build replay recovery/ });
  expect(row.getAttribute("aria-label")).toContain(", unread");
  expect(row.getAttribute("aria-label")).toContain("Codex · 1 subagent running");
  expect(mark(row)).toBe("live");
  // The subagent finishes but the root still works: still never the finished dot.
  app.daemon.apply("build", [facts.endTurn("web")]);
  await waitFor(() => expect(row.getAttribute("aria-label")).not.toContain("subagent running"));
  expect(mark(row)).toBe("live");
});

test("agents running beside a human request remain counted until they finish", async () => {
  const app = harness();
  task(app, "build", "Build replay recovery");
  app.daemon.apply("build", [
    facts.subagent("codex", "web", "Web", "spawn"),
    facts.turn("web", "spawn"),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "approve",
      blocking: true,
      request: { kind: "approval", title: "Publish", options: [] },
    },
  ]);
  await app.open("/new");
  const row = await activeRow("Build replay recovery");
  await waitFor(() =>
    expect(row.getAttribute("aria-label")).toContain("Codex · 1 subagent running"),
  );
  expect(tone(row)).toBe("needs-you");
  app.daemon.apply("build", [facts.endTurn("web")]);
  await waitFor(() => expect(row.getAttribute("aria-label")).not.toContain("subagent running"));
  expect(tone(row)).toBe("needs-you");
});

test("renaming an empty draft cannot turn it into a task", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "draft",
    title: "New thread",
    workspaceId: "ace",
    provider: "opencode",
  });
  app.daemon.updateThread("draft", { title: "Renamed draft" });
  await app.open("/new");
  await screen.findByText("No threads yet");
  expect(screen.queryByRole("link", { name: /^Renamed draft/ })).toBeNull();
  app.daemon.apply("draft", [
    facts.rootAgent("opencode"),
    facts.turn("root"),
    facts.message("root", "sent", "user", "Fix replay"),
  ]);
  expect(await screen.findByRole("link", { name: /^Renamed draft/ })).toBeTruthy();
});

test.each([false, true])(
  "a row names its device only in its name and hover card, while two devices are connected (remote=%s)",
  async (remote) => {
    const app = harness({ machines: [{ hostId: "build", name: "Build server" }] });
    app.daemon.services.settings.seed({
      "host.displayName": "Workshop Mac",
      "host.icon": { kind: "desktop" },
    });
    app.machines.get("build")?.services.settings.seed({ "host.icon": { kind: "server" } });
    const scenario = runningTests();
    app
      .play({
        ...scenario,
        thread: {
          ...scenario.thread,
          details: {
            ...scenario.thread.details,
            ...(remote
              ? {
                  machine: {
                    host: "build",
                    name: "Stale server",
                    icon: { kind: "server" as const },
                  },
                }
              : {}),
          },
        },
      })
      .runUntilBlocked();
    await app.open("/new");
    const row = await (
      await rows()
    ).findByRole("link", { name: new RegExp(`^${scenario.thread.title}`) });
    const name = remote ? "Build server" : "Workshop Mac";
    if (!row.parentElement) throw new Error("No row container");
    // Two devices are connected: still the row draws neither the machine's icon nor its name.
    expect(within(row).queryByRole("img", { name: /machine icon$/ })).toBeNull();
    expect(within(row).queryByText(name, { exact: true })).toBeNull();
    expect(row.textContent).not.toContain("Stale server");
    expect(row.getAttribute("aria-label")).toContain(`Running on ${name}`);
    expect(row.getAttribute("aria-label")).toContain("Codex");
    await userEvent.hover(row);
    expect((await screen.findByLabelText(/^Details for /)).textContent).toContain(name);
    await userEvent.unhover(row);
    row.focus();
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect((await screen.findByLabelText(/^Details for /)).textContent).toContain(name);
  },
);
