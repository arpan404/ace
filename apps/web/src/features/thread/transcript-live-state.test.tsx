import { ThreadId } from "@ace/protocol";
import { facts, accountLimit, flakyCheckout, type Scenario } from "@ace/fake-daemon";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
import { createTimeSource, TimeContext } from "@/lib/time.ts";
import { ActivityLine } from "./transcript/live-footer.tsx";

beforeEach(() => localStorage.clear());

const id = "thread-live-state";
const initial = () => [
  facts.rootAgent("codex"),
  facts.turn("root"),
  facts.message("root", "ask", "user", "Check the replay cursor."),
  facts.tool("root", "build", {
    kind: "shell",
    title: "bun run build",
    detail: { kind: "shell", command: "bun run build" },
  }),
];
const scenario = (events = initial()): Scenario => ({
  thread: { id, title: "Replay cursor", workspaceId: "ace", provider: "codex" },
  steps: [{ kind: "facts", facts: events }],
});
const live = () => screen.getByRole("button", { name: "Open work and agents" });

async function running(events = initial()) {
  let now = 1_000;
  const app = harness({ clock: () => now, uiClock: () => now });
  app.play(scenario(events)).runUntilBlocked();
  now = 75_000;
  const view = await app.open(`/t/${id}`);
  await waitFor(() => expect(live().textContent).toContain("Working for 1m 14s"));
  return {
    app,
    view,
    setTime: (value: number) => {
      now = value;
    },
  };
}

test("reload and reconnect preserve the server start of a partial turn", async () => {
  const { app, view } = await running([
    ...initial(),
    facts.message("root", "answer", "assistant", "Checking", false),
  ]);
  act(() => {
    app.daemon.refuseConnections(true);
    app.daemon.disconnectAll();
  });
  await waitFor(() => expect(app.client.state).not.toBe("ready"));
  act(() => app.daemon.refuseConnections(false));
  await waitFor(() => expect(app.client.state).toBe("ready"));
  await waitFor(() => expect(live().textContent).toContain("Working for 1m 14s"));
  view.unmount();
  await app.client.close();
  const reloaded = harness({ daemon: app.daemon, uiClock: () => 75_000 });
  await reloaded.open(`/t/${id}`);
  await waitFor(() => expect(live().textContent).toContain("Working for 1m 14s"));
  act(() => app.daemon.apply(id, [facts.stream("root", "answer", " the replay cursor.")]));
  expect(await screen.findByText("Checking the replay cursor.")).toBeTruthy();
  expect(live().textContent).toContain("Working for 1m 14s");
});

test("steering into an active turn preserves its elapsed time and shows the new action", async () => {
  const { app } = await running();
  act(() =>
    app.daemon.apply(id, [
      facts.message("root", "steer", "user", "Check mobile too."),
      facts.toolDone("root", "build"),
      facts.tool("root", "mobile", {
        kind: "file.read",
        title: "Read mobile.ts",
        detail: { kind: "file.read", path: "mobile.ts" },
      }),
    ]),
  );
  await waitFor(() => expect(live().textContent).toContain("mobile.ts"));
  expect(live().textContent).toContain("Working for 1m 14s");
});

test("queued input does not replace the settled turn summary with a new working timer", async () => {
  const { app } = await running();
  await userEvent.type(screen.getByRole("combobox", { name: "Message" }), "Check mobile next.");
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("list", { name: "Queued messages" });
  const lease = app.client.thread(id);
  const revision = lease.store.queue?.revision ?? 0;
  lease.release();
  await app.client.command({
    type: "queue.pause",
    threadId: ThreadId.parse(id),
    expectedRevision: revision,
  });
  act(() => app.daemon.apply(id, [facts.toolDone("root", "build"), facts.endTurn("root")]));
  const feed = screen.getByRole("feed", { name: "Transcript" });
  expect(await within(feed).findByRole("button", { name: /^Worked for 1m 14s/ })).toBeTruthy();
  expect(screen.queryByText(/^Working for/)).toBeNull();
  expect(within(feed).queryByText("Check mobile next.")).toBeNull();
});

const child = () => [
  facts.tool("root", "spawn", {
    kind: "agent.spawn",
    title: "Audit replay",
    detail: { kind: "agent.spawn", description: "Audit replay", childAgent: "audit" },
  }),
  facts.subagent("codex", "audit", "Auditor", "spawn"),
  facts.turn("audit", "spawn"),
  facts.toolDone("root", "spawn"),
];

test("a parent answer stays working until its subagent finishes and its line opens Agents", async () => {
  const { app } = await running([
    ...initial(),
    ...child(),
    facts.tool("audit", "audit-check", {
      kind: "shell",
      title: "bun run audit",
      detail: { kind: "shell", command: "bun run audit" },
    }),
  ]);
  act(() =>
    app.daemon.apply(id, [
      facts.toolDone("root", "build"),
      facts.message("root", "answer", "assistant", "The parent finished."),
      facts.endTurn("root"),
    ]),
  );
  await waitFor(() => expect(live().textContent).toContain("1 subagent"));
  expect(live().textContent).toContain("Running bun run audit");
  act(() =>
    app.daemon.apply(id, [
      facts.tool("audit", "audit-check", {
        kind: "shell",
        title: "bun run audit mobile",
        detail: { kind: "shell", command: "bun run audit mobile" },
      }),
    ]),
  );
  await waitFor(() => expect(live().textContent).toContain("Running bun run audit mobile"));
  expect(screen.queryByRole("button", { name: /^Worked for/ })).toBeNull();
  await userEvent.click(live());
  expect(await screen.findByRole("region", { name: "Thread panel" })).toBeTruthy();
  act(() => app.daemon.apply(id, [facts.toolDone("audit", "audit-check"), facts.endTurn("audit")]));
  expect(await screen.findByRole("button", { name: /^Worked for 1m 14s/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open work and agents" })).toBeNull();
});

test("only a background shell keeps the live timer until the shell ends", async () => {
  const { app } = await running([
    ...initial(),
    {
      type: "background.started",
      agent: "root",
      task: "build",
      kind: "shell",
      title: "bun run build",
      item: "build",
      stoppable: true,
    },
  ]);
  act(() => app.daemon.apply(id, [facts.endTurn("root")]));
  await waitFor(() => expect(live().textContent).toContain("1 background command"));
  expect(live().textContent).toContain("Working for 1m 14s");
  expect(screen.queryByRole("button", { name: /^Worked for/ })).toBeNull();
  act(() =>
    app.daemon.apply(id, [
      { type: "background.ended", task: "build", status: "completed" },
      facts.toolDone("root", "build"),
    ]),
  );
  expect(await screen.findByRole("button", { name: /^Worked for 1m 14s/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open work and agents" })).toBeNull();
});

test("approval inside a subagent holds the parent in a needs-you state without a timer", async () => {
  const { app } = await running([...initial(), ...child()]);
  act(() =>
    app.daemon.apply(id, [
      facts.toolDone("root", "build"),
      facts.endTurn("root"),
      {
        type: "interaction.opened",
        agent: "audit",
        interaction: "approval",
        blocking: true,
        request: {
          kind: "approval",
          title: "Run the audit?",
          options: [
            { id: "allow", kind: "allow_once", label: "Allow once" },
            { id: "deny", kind: "deny", label: "Deny" },
          ],
        },
      },
    ]),
  );
  expect(await screen.findByRole("link", { name: "Waiting for your approval" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Worked for/ })).toBeNull();
  expect(screen.queryByText(/^Working for/)).toBeNull();
});

for (const [outcome, label, at] of [
  ["completed", "Worked for 6m 32s", 393_000],
  ["interrupted", "Stopped after 2m 10s", 131_000],
  ["failed", "Failed after 40s", 41_000],
] as const) {
  test(`${outcome} turns retain a collapsible log with their server duration`, async () => {
    const { app, setTime } = await running();
    setTime(at);
    act(() =>
      app.daemon.apply(id, [facts.toolDone("root", "build"), facts.endTurn("root", outcome)]),
    );
    const summary = await screen.findByRole("button", { name: new RegExp(`^${label}`) });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(summary);
    expect(await screen.findByRole("button", { name: "Ran bun run build" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open work and agents" })).toBeNull();
  });
}

test("a usage-limit pause has a collapsible divider while it waits", async () => {
  const app = harness();
  app.play(accountLimit(id, "Replay cursor")).runUntilBlocked();
  await app.open(`/t/${id}`);
  const summary = await screen.findByRole("button", { name: /Paused · Codex usage limit/ });
  await userEvent.click(summary);
  expect(await screen.findByRole("list", { name: "Steps" })).toBeTruthy();
  expect(screen.queryByText(/^Working for/)).toBeNull();
});

test("successive text-only turns each retain their own worked duration", async () => {
  const { app, setTime } = await running(initial().slice(0, 3));
  setTime(11_000);
  act(() =>
    app.daemon.apply(id, [
      facts.message("root", "first", "assistant", "First answer."),
      facts.endTurn("root"),
    ]),
  );
  expect(await screen.findByRole("button", { name: /^Worked for 10s/ })).toBeTruthy();
  setTime(21_000);
  act(() =>
    app.daemon.apply(id, [
      { type: "turn.started", agent: "root", nativeTurnId: "second", trigger: "user" },
      facts.message("root", "second-ask", "user", "Continue."),
    ]),
  );
  setTime(41_000);
  act(() =>
    app.daemon.apply(id, [
      facts.message("root", "second", "assistant", "Second answer."),
      { type: "turn.ended", agent: "root", nativeTurnId: "second", outcome: "completed" },
    ]),
  );
  expect(await screen.findByRole("button", { name: /^Worked for 20s/ })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /^Worked for/ })).toHaveLength(2);
});

test("the live line ticks with an injected clock and stops ticking when approval waits", () => {
  vi.useFakeTimers();
  let now = 75_000;
  try {
    const time = createTimeSource(() => now);
    const view = render(
      <TimeContext value={time}>
        <ActivityLine
          activity={{
            label: "Working",
            tone: "working",
            elapsedFrom: 1_000,
            current: "Running build",
          }}
        />
      </TimeContext>,
    );
    expect(screen.getByRole("status").textContent).toContain("Working for 1m 14s");
    now = 76_000;
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("status").textContent).toContain("Working for 1m 15s");
    view.rerender(
      <TimeContext value={time}>
        <ActivityLine
          activity={{
            label: "Waiting for your approval",
            tone: "needs-you",
            elapsedFrom: undefined,
            current: undefined,
          }}
        />
      </TimeContext>,
    );
    now = 200_000;
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("status").textContent).toBe("Waiting for your approval");
    view.unmount();
  } finally {
    vi.useRealTimers();
  }
});

test("approval cards show the command, risk and decisions without an empty spinning step", async () => {
  const app = harness();
  app.play(flakyCheckout()).runThrough("approval-requested");
  await app.open("/t/thread-checkout");
  const card = await screen.findByRole("article", {
    name: "Run rm -rf node_modules/.cache/vitest?",
  });
  expect(within(card).getByText(/High risk/)).toBeTruthy();
  expect(within(card).getByRole("button", { name: "Allow once" })).toBeTruthy();
  expect(within(card).getByRole("button", { name: "Deny" })).toBeTruthy();
  expect(within(card).getByRole("button", { name: /Details/ })).toBeTruthy();
  const feed = screen.getByRole("feed", { name: "Transcript" });
  expect(within(feed).queryByRole("button", { name: "" })).toBeNull();
  expect(within(feed).queryByText("0s")).toBeNull();
  await userEvent.click(within(feed).getByRole("button", { name: "1 subagent" }));
  expect(within(feed).queryByRole("button", { name: "Subagent actions" })).toBeNull();
});

test("the empty working composer exposes Stop and Escape stops the turn", async () => {
  await running();
  expect(screen.getByRole("button", { name: "Stop the agent" })).toBeTruthy();
  expect(screen.queryByText("Beginning of thread")).toBeNull();
  expect(screen.queryByText("New activity")).toBeNull();
  expect(screen.queryByText("Work so far")).toBeNull();
  expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
  screen.getByRole("combobox", { name: "Message" }).focus();
  await userEvent.keyboard("{Escape}");
  expect(await screen.findByRole("button", { name: /^Stopped after/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
});

for (const waiting of [false, true]) {
  test(`an older turn stays unsettled while its silent child ${waiting ? "awaits approval" : "works"}, after a newer root turn answers`, async () => {
    const { app, setTime } = await running([...initial(), ...child()]);
    act(() =>
      app.daemon.apply(id, [
        facts.toolDone("root", "build"),
        facts.message("root", "first-answer", "assistant", "First answer."),
        facts.endTurn("root"),
      ]),
    );
    setTime(90_000);
    act(() =>
      app.daemon.apply(id, [
        { type: "turn.started", agent: "root", nativeTurnId: "second-root", trigger: "user" },
        facts.message("root", "second-ask", "user", "Check the next change."),
        facts.message("root", "second-answer", "assistant", "Second answer."),
        ...(waiting
          ? [
              {
                type: "interaction.opened" as const,
                agent: "audit",
                interaction: "silent-approval",
                blocking: true,
                request: {
                  kind: "approval" as const,
                  title: "Approve the silent audit?",
                  options: [{ id: "deny", kind: "deny" as const, label: "Deny" }],
                },
              },
            ]
          : []),
      ]),
    );
    await screen.findByText("Second answer.");
    expect(screen.queryByRole("button", { name: /^Worked for/ })).toBeNull();
    if (waiting) {
      await userEvent.click(
        within(await screen.findByRole("region", { name: "Waiting for you" })).getByRole("button", {
          name: "Deny",
        }),
      );
    }
    act(() => app.daemon.apply(id, [facts.endTurn("audit")]));
    expect(await screen.findByRole("button", { name: /^Worked for 1m 29s/ })).toBeTruthy();
  });
}
