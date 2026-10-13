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

test("a plan review says Needs you and explains the request on hover", async () => {
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
  const row = await (await rows()).findByRole("link", { name: /^Review reconnect recovery/ });
  expect(within(row).getByText("Needs you", { exact: true })).toBeTruthy();
  expect(row.getAttribute("aria-label")).toContain("Waiting for your review");
  await userEvent.hover(row);
  expect((await screen.findByLabelText(/^Details for /)).textContent).toContain(
    "Review reconnect recovery",
  );
});

test.each([
  [askingQuestion, "Answer", "Waiting for your answer"],
  [waitingOnSubagents, "Working", "Claude Code · 2 subagents running"],
  [watchingRelay, "Background · 1", "Running in background bun run dev:relay"],
  [runningTests, "Working", "Working · running tests"],
])(
  "short row statuses keep the full explanation for hover and screen readers: %s",
  async (scenario, short, full) => {
    const app = harness();
    const example = scenario();
    app.play(example).runUntilBlocked();
    await app.open("/new");
    const row = await (
      await rows()
    ).findByRole("link", { name: new RegExp(`^${example.thread.title}`) });
    expect(within(row).getByText(short, { exact: true })).toBeTruthy();
    expect(row.getAttribute("aria-label")).toContain(full);
    await userEvent.hover(row);
    expect((await screen.findByLabelText(/^Details for /)).textContent).toContain(
      example.thread.title,
    );
  },
);

test("task context shows branch, environment and provider while hover keeps the full status and diff details", async () => {
  const app = harness();
  task(app, "build", "Build replay recovery");
  await app.open("/new");
  const row = await (await rows()).findByRole("link", { name: /^Build replay recovery/ });
  expect(within(row).getByText("Working", { exact: true })).toBeTruthy();
  expect(within(row).queryByText("Working · Codex")).toBeNull();
  expect(within(row).getByText("fix/replay")).toBeTruthy();
  expect(row.getAttribute("aria-label")).toContain("Working");
  expect(within(row).getByRole("img", { name: "draft pull request #283" })).toBeTruthy();
  expect(within(row).queryByText("+24")).toBeNull();
  expect(within(row).queryByText("−6")).toBeNull();
  expect(row.getAttribute("aria-label")).toContain("Codex");
  expect(within(row).getByRole("img", { name: "Codex" })).toBeTruthy();
  await userEvent.hover(row);
  const tip = await screen.findByLabelText(/^Details for /);
  expect(tip.textContent).toContain("Build replay recovery");
  expect(within(tip).getByRole("img", { name: "draft pull request #283" })).toBeTruthy();
  expect(within(tip).getByRole("img", { name: "24 lines added, 6 lines removed" })).toBeTruthy();
});

test("this device's read cursor shows new activity even while a task works", async () => {
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
  expect(within(row).getByRole("img", { name: "Codex · 1 subagent running" })).toBeTruthy();
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
  const row = await (await rows()).findByRole("link", { name: /^Build replay recovery/ });
  expect(within(row).getByText("Approve")).toBeTruthy();
  expect(row.getAttribute("aria-label")).toContain("Codex · 1 subagent running");
  expect(within(row).getByRole("img", { name: "Codex · 1 subagent running" })).toBeTruthy();
  app.daemon.apply("build", [facts.endTurn("web")]);
  await waitFor(() => expect(row.getAttribute("aria-label")).not.toContain("subagent running"));
  expect(within(row).getByText("Approve")).toBeTruthy();
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
  "a row shows its device icon, never its name, while two devices are connected (remote=%s)",
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
    // Two devices are connected: the row shows the machine's icon, never its name.
    expect(
      within(row).getByRole("img", { name: `${remote ? "server" : "desktop"} machine icon` }),
    ).toBeTruthy();
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
