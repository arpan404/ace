import type { Fact } from "@ace/core";
import { facts, flakyCheckout, type FakeDaemon, type Scenario } from "@ace/fake-daemon";
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { answerStore } from "@/features/thread/interactions/answers.ts";
import { harness } from "@/test/harness.tsx";

/*
 * A thread's copy the daemon hasn't confirmed (here: the connection is coming back) shows no
 * live state and takes no action as if it were current. Once the daemon is back, all of it is.
 */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());
afterEach(() => answerStore.forgetAll());

const held = "Reconnecting… Answer once this request is confirmed.";

/** The connection drops and every reconnect is refused, until `back`. */
function dropConnection(app: ReturnType<typeof harness>) {
  act(() => app.daemon.refuseConnections(true));
  return async () => {
    act(() => app.daemon.refuseConnections(false));
    act(() => app.client.reconnectNow());
    await waitFor(() => expect(app.client.state).toBe("ready"));
  };
}

/** Every command frame the client sends the daemon, as sent. */
function commandsSent(daemon: FakeDaemon) {
  const sent: { type: string; [key: string]: unknown }[] = [];
  const connect = daemon.connect.bind(daemon);
  daemon.connect = (wire) => {
    const connection = connect(wire);
    const receive = connection.receive.bind(connection);
    connection.receive = (text: string) => {
      const message: unknown = JSON.parse(text);
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "command" &&
        "command" in message
      ) {
        const command = message.command as { payload: { type: string } };
        sent.push(command.payload);
      }
      receive(text);
    };
    return connection;
  };
  return sent;
}

test("while reconnecting, a pending approval stays in view but can't be answered, and answers once confirmed", async () => {
  const app = harness();
  app.play(flakyCheckout()).runThrough("approval-requested");
  await app.open("/t/thread-checkout");
  const stack = await screen.findByRole("region", { name: "Waiting for you" });
  const card = await within(stack).findByRole("article", {
    name: "Run rm -rf node_modules/.cache/vitest?",
  });
  const back = dropConnection(app);

  expect(await within(card).findByText(held)).toBeTruthy();
  const allow = within(card).getByRole<HTMLButtonElement>("button", { name: "Allow once" });
  expect(allow.disabled).toBe(true);
  // Neither its button nor its number key answers it.
  await userEvent.click(allow);
  card.focus();
  await userEvent.keyboard("1");
  expect(app.daemon.isPending("thread-checkout", "approve-clear-cache")).toBe(true);

  await back();
  await waitFor(() => expect(screen.queryByText(held)).toBeNull());
  await userEvent.click(await screen.findByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    expect(app.daemon.resolution("thread-checkout", "approve-clear-cache")).toEqual({
      kind: "approval",
      optionId: "allow",
    }),
  );
});

/** A Codex thread whose agent asks one question that takes typed words, and waits. */
function asksIndentation(): Scenario {
  return {
    thread: { id: "thread-indent", workspaceId: "relay", title: "Indentation", provider: "codex" },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("codex"),
          facts.turn("root"),
          {
            type: "interaction.opened",
            agent: "root",
            interaction: "indent",
            blocking: true,
            request: {
              kind: "question",
              questions: [
                {
                  id: "style",
                  header: "Indentation",
                  text: "Tabs or Spaces?",
                  multiSelect: false,
                  allowOther: true,
                  secret: false,
                  options: [
                    { id: "tabs", label: "Tabs" },
                    { id: "spaces", label: "Spaces" },
                  ],
                },
              ],
            },
          },
        ],
      },
      { kind: "await", interaction: "indent" },
    ],
  };
}

test("while reconnecting, words typed to a cached question stay in the composer and never become its answer", async () => {
  const app = harness();
  app.play(asksIndentation()).runUntilBlocked();
  await app.open("/t/thread-indent");
  await screen.findByRole("article", { name: "Tabs or Spaces?" });
  const message = screen.getByRole("combobox", { name: "Message" });
  const back = dropConnection(app);
  await screen.findByText(held);

  await userEvent.type(message, "Two spaces{Enter}");
  expect(await screen.findByText("Reply not sent")).toBeTruthy();
  await waitFor(() => expect(message.textContent).toBe("Two spaces"));

  await back();
  // Nothing went meanwhile: neither an answer nor a message.
  expect(app.daemon.isPending("thread-indent", "indent")).toBe(true);
  expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull();
  await waitFor(() => expect(screen.queryByText(held)).toBeNull());
  await userEvent.type(message, "{Enter}");
  await waitFor(() =>
    expect(app.daemon.resolution("thread-indent", "indent")).toEqual({
      kind: "question",
      answers: { style: ["Two spaces"] },
    }),
  );
});

const reviewing: Fact[] = [
  facts.rootAgent("claude"),
  facts.turn("root"),
  facts.tool("root", "spawn-reviewer", {
    kind: "agent.spawn",
    title: "Review the changes",
    detail: { kind: "agent.spawn", description: "Review the diff", childAgent: "reviewer" },
  }),
  facts.subagent("claude", "reviewer", "Reviewer", "spawn-reviewer"),
  facts.turn("reviewer", "spawn"),
  facts.subagent("claude", "child", "Child", "spawn-child", { parent: "reviewer" }),
  facts.turn("child"),
];

/** A thread whose subagent Reviewer works, with a subagent of its own, on Reviewer's page. */
async function openReviewer() {
  const app = harness();
  const sent = commandsSent(app.daemon);
  app.daemon.createThread({
    id: "review",
    workspaceId: "relay",
    provider: "claude",
    title: "Review changes",
  });
  app.daemon.apply("review", reviewing);
  await app.open("/t/review");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const card = await within(feed).findByRole("region", { name: "1 subagent" });
  await userEvent.click(within(card).getByRole("link", { name: /^Open Reviewer,/ }));
  await screen.findByRole("heading", { level: 1, name: "Reviewer" });
  return { app, sent, bar: screen.getByRole("group", { name: "Subagent" }) };
}

test("while reconnecting, a working subagent's page says so instead of Working, with no timer and no Stop", async () => {
  const { app, bar } = await openReviewer();
  expect(within(bar).getByText(/^Working for/)).toBeTruthy();
  expect(screen.getByRole("status", { name: "Working" })).toBeTruthy();
  const back = dropConnection(app);

  await waitFor(() => expect(within(bar).queryByText(/^Working for/)).toBeNull());
  expect(within(bar).getByText("Reconnecting…")).toBeTruthy();
  expect(within(bar).queryByRole("button", { name: /^Stop/ })).toBeNull();
  expect(screen.queryByRole("status", { name: "Working" })).toBeNull();
  expect(within(bar).queryByText(/^Completed/)).toBeNull();

  await back();
  expect(await within(bar).findByText(/^Working for/)).toBeTruthy();
  expect(within(bar).getByRole("button", { name: /^Stop Reviewer/ })).toBeTruthy();
});

test("Stop names the run it was pressed in: once that run is over, the daemon refuses it and the later run keeps working", async () => {
  const { app, sent, bar } = await openReviewer();
  await userEvent.click(within(bar).getByRole("button", { name: /^Stop Reviewer/ }));
  const confirm = await screen.findByRole("dialog", { name: /^Stop Reviewer/ });
  // Before it is confirmed, the run it was pressed in ends and Reviewer starts another.
  act(() =>
    app.daemon.apply("review", [
      facts.endTurn("reviewer"),
      { type: "turn.started", agent: "reviewer", nativeTurnId: "reviewer-again", trigger: "user" },
    ]),
  );
  await userEvent.click(within(confirm).getByRole("button", { name: "Stop all" }));

  await waitFor(() =>
    expect(sent.some((command) => command.type === "thread.interrupt")).toBe(true),
  );
  const stop = sent.find((command) => command.type === "thread.interrupt");
  expect(stop?.runId).toEqual(expect.any(String));
  expect((await screen.findAllByText("Couldn't stop this agent")).length).toBeGreaterThan(0);
  expect(within(bar).getByText(/^Working for/)).toBeTruthy();

  // Pressed in the run that works now, it stops it.
  await userEvent.click(within(bar).getByRole("button", { name: /^Stop Reviewer/ }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: /^Stop Reviewer/ })).getByRole("button", {
      name: "Stop all",
    }),
  );
  expect(await within(bar).findByText(/^Stopped after/)).toBeTruthy();
});
