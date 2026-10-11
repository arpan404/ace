import { ClientProvider } from "@ace/client-react";
import { FakeDaemon, ScenarioPlayer, facts, type Scenario } from "@ace/fake-daemon";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { ServerMessage } from "@ace/protocol";
import { expect, test, vi } from "vitest";
import { fakeClient } from "@/test/fake-client.ts";
import { ThreadNavProvider } from "./nav.tsx";
import { useTurnHead, useTurnSummary } from "./turn-index.ts";

type Fact = Parameters<FakeDaemon["apply"]>[1][number];

function Summaries() {
  const head = useTurnHead("turn-freshness");
  const turn = useTurnSummary("turn-freshness", 1);
  return (
    <>
      <output aria-label="head">{head?.latest?.outcome}</output>
      <output aria-label="state">{turn?.status.state}</output>
      <output aria-label="approvals">
        {turn?.digest.approvalsPending}/{turn?.digest.approvalsAnswered}
      </output>
      <output aria-label="block">
        {turn?.outcome}: {turn?.latestAgentMessagePreview}{" "}
        {turn?.endedAt === undefined ? "timing" : "stopped"}
      </output>
    </>
  );
}

test("a visible turn head and block settle and show the final answer without a new ordinal", async () => {
  const scenario: Scenario = {
    thread: {
      id: "turn-freshness",
      workspaceId: "project",
      provider: "codex",
      title: "Fresh turns",
    },
    steps: [
      {
        kind: "facts",
        label: "working",
        facts: [
          facts.rootAgent("codex"),
          facts.turn("root"),
          facts.message("root", "ask", "user", "Work"),
          facts.message("root", "answer", "assistant", "Draft answer", false),
          {
            type: "interaction.opened",
            agent: "root",
            interaction: "approve",
            blocking: true,
            request: {
              kind: "approval",
              title: "Run command",
              description: "Allow command",
              options: [{ id: "allow", label: "Approve", kind: "allow_once" }],
            },
          },
        ],
      },
      {
        kind: "facts",
        label: "finished",
        facts: [
          facts.message("root", "answer", "assistant", "Final answer"),
          {
            type: "interaction.closed",
            interaction: "approve",
            state: "resolved",
            resolution: { kind: "approval", optionId: "allow" },
          },
          facts.endTurn("root"),
        ],
      },
    ],
  };
  let time = 1000;
  const daemon = new FakeDaemon({ clock: () => ++time });
  const script = new ScenarioPlayer(daemon, scenario);
  script.runThrough("working");
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <ClientProvider client={client}>
      <QueryClientProvider client={cache}>
        <ThreadNavProvider threadId="turn-freshness">
          <Summaries />
        </ThreadNavProvider>
      </QueryClientProvider>
    </ClientProvider>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("block").textContent).toBe("active: Draft answer timing"),
  );
  expect(screen.getByLabelText("approvals").textContent).toBe("1/0");
  let replies = 0;
  const stop = client.onMessage((message) => {
    if (message.type === "turns.page") replies++;
  });
  act(() => {
    for (let n = 0; n < 100; n++)
      daemon.apply("turn-freshness", [
        facts.message("root", "answer", "assistant", `Draft ${n}`, false),
      ]);
    script.runThrough("finished");
  });
  await waitFor(() => expect(screen.getByLabelText("head").textContent).toBe("completed"));
  await waitFor(() =>
    expect(screen.getByLabelText("block").textContent).toBe("completed: Final answer stopped"),
  );
  expect(screen.getByLabelText("approvals").textContent).toBe("0/1");
  expect(replies).toBe(2);
  stop();
  view.unmount();
  cache.clear();
});

test("late work on an old visible full block refreshes that summary without reading the whole history", async () => {
  let time = 1000;
  const daemon = new FakeDaemon({ clock: () => ++time });
  const history: Fact[] = [facts.rootAgent("codex")];
  for (let ordinal = 1; ordinal <= 51; ordinal++) {
    history.push(
      { type: "turn.started", agent: "root", nativeTurnId: `turn-${ordinal}`, trigger: "user" },
      facts.message("root", `ask-${ordinal}`, "user", `Turn ${ordinal}`),
    );
    if (ordinal === 1)
      history.push(
        facts.tool("root", "old-shell", {
          kind: "shell",
          title: "Build",
          detail: { kind: "shell", command: "build" },
        }),
        {
          type: "background.started",
          agent: "root",
          task: "old-task",
          kind: "shell",
          title: "Build",
          item: "old-shell",
          stoppable: true,
        },
      );
    history.push(facts.message("root", `answer-${ordinal}`, "assistant", `Answer ${ordinal}`), {
      type: "turn.ended",
      agent: "root",
      nativeTurnId: `turn-${ordinal}`,
      outcome: "completed",
    });
  }
  new ScenarioPlayer(daemon, {
    thread: {
      id: "turn-freshness",
      workspaceId: "project",
      provider: "codex",
      title: "Older work",
    },
    steps: [{ kind: "facts", facts: history }],
  }).runUntilBlocked();
  const client = fakeClient(daemon);
  await client.start();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <ClientProvider client={client}>
      <QueryClientProvider client={cache}>
        <ThreadNavProvider threadId="turn-freshness">
          <Summaries />
        </ThreadNavProvider>
      </QueryClientProvider>
    </ClientProvider>,
  );
  await waitFor(() => expect(screen.getByLabelText("state").textContent).toBe("waiting"));
  expect(screen.getByLabelText("block").textContent).toContain("completed: Answer 1");
  let replies = 0;
  const stop = client.onMessage((message) => {
    if (message.type === "turns.page") replies++;
  });
  act(() =>
    daemon.apply("turn-freshness", [
      facts.toolDone("root", "old-shell"),
      { type: "background.ended", task: "old-task", status: "completed" },
    ]),
  );
  await waitFor(() => expect(screen.getByLabelText("state").textContent).toBe("done"));
  expect(screen.getByLabelText("block").textContent).toContain("completed: Answer 1");
  expect(replies).toBe(2);
  stop();
  view.unmount();
  cache.clear();
});

/** Delay replies at the socket boundary, after the daemon has taken the read's snapshot. */
class SlowTurnsDaemon extends FakeDaemon {
  delayed = false;
  reads = 0;
  override connect(wire: Parameters<FakeDaemon["connect"]>[0]) {
    return super.connect({
      ...wire,
      send: (text) => {
        const message = ServerMessage.parse(JSON.parse(text));
        if (this.delayed && message.type === "turns.page") {
          this.reads++;
          setTimeout(() => wire.send(text), 300);
        } else wire.send(text);
      },
    });
  }
}

test("slow visible summaries make progress during sustained revisions and catch changes made while reading", async () => {
  let time = 1000;
  const daemon = new SlowTurnsDaemon({ clock: () => ++time });
  new ScenarioPlayer(daemon, {
    thread: {
      id: "turn-freshness",
      workspaceId: "project",
      provider: "codex",
      title: "Slow summaries",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("codex"),
          facts.turn("root"),
          facts.message("root", "ask", "user", "Work"),
          facts.message("root", "answer", "assistant", "Draft answer", false),
        ],
      },
    ],
  }).runUntilBlocked();
  const client = fakeClient(daemon);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let view: ReturnType<typeof render> | undefined;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await act(async () => {
      await client.start();
      await vi.advanceTimersByTimeAsync(1);
    });
    view = render(
      <ClientProvider client={client}>
        <QueryClientProvider client={cache}>
          <ThreadNavProvider threadId="turn-freshness">
            <Summaries />
          </ThreadNavProvider>
        </QueryClientProvider>
      </ClientProvider>,
    );
    // Drain initial snapshot revisions using the same clock as the later slow reads.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(screen.getByLabelText("block").textContent).toContain("Draft answer");
    daemon.delayed = true;
    for (let revision = 1; revision <= 10; revision++) {
      await act(async () => {
        daemon.apply("turn-freshness", [
          facts.message("root", "answer", "assistant", `Revision ${revision}`, false),
        ]);
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    // Events have never paused for a full read, but earlier snapshots must still land.
    expect(screen.getByLabelText("block").textContent).toMatch(/Revision [1-9]/);
    expect(daemon.reads).toBeLessThanOrEqual(8);
    await act(async () => {
      daemon.apply("turn-freshness", [
        facts.message("root", "answer", "assistant", "Final answer"),
        facts.endTurn("root"),
      ]);
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByLabelText("block").textContent).toBe("completed: Final answer stopped");
    expect(screen.getByLabelText("head").textContent).toBe("completed");
  } finally {
    view?.unmount();
    cache.clear();
    vi.useRealTimers();
  }
});
