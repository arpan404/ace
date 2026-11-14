import { facts, flakyCheckout, type Scenario } from "@ace/fake-daemon";
import { act, configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { answerStore } from "@/features/thread/interactions/answers.ts";
import { slowReplay } from "@/test/held-replay.ts";
import { harness } from "@/test/harness.tsx";

/*
 * The window after a reconnect's welcome and before its replay lands: connected, but every copy
 * still says what was true before the drop. Nothing may claim it as live or act on it.
 */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());
afterEach(() => answerStore.forgetAll());

/** A harness whose daemon can hold the replay. */
function slowDaemon() {
  const app = harness();
  return { app, replay: slowReplay(app.daemon) };
}

const approval = "Run rm -rf node_modules/.cache/vitest?";

test("connected again but not caught up: the approval waits, the palette offers no approve, and both work once the replay lands", async () => {
  const { app, replay } = slowDaemon();
  app.play(flakyCheckout()).runThrough("approval-requested");
  await app.open("/t/thread-checkout");
  const stack = await screen.findByRole("region", { name: "Waiting for you" });
  await within(stack).findByRole("article", { name: approval });

  await replay.hold(app.client);
  expect(await screen.findByText("Syncing… Answer once this request is confirmed.")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Allow once" }).disabled).toBe(true);
  await userEvent.keyboard("{Meta>}k{/Meta}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search commands" }), "approve");
  expect(screen.queryByRole("option", { name: /^Allow once/ })).toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(app.daemon.isPending("thread-checkout", "approve-clear-cache")).toBe(true);

  replay.release(app.client);
  await waitFor(() =>
    expect(screen.queryByText("Syncing… Answer once this request is confirmed.")).toBeNull(),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    expect(app.daemon.resolution("thread-checkout", "approve-clear-cache")).toEqual({
      kind: "approval",
      optionId: "allow",
    }),
  );
});

test("an approval clicked in the instant the connection drops, before the screen redraws, sends nothing", async () => {
  const { app } = slowDaemon();
  app.play(flakyCheckout()).runThrough("approval-requested");
  await app.open("/t/thread-checkout");
  const allow = await screen.findByRole<HTMLButtonElement>("button", { name: "Allow once" });
  // The client goes stale, and in that same moment, before React redraws, the still-enabled
  // button is pressed.
  let enabledWhenPressed = false;
  await act(
    () =>
      new Promise<void>((resolve) => {
        const connection = app.client.connectionState();
        const stop = connection.subscribe(() => {
          if (connection.getSnapshot() === "ready") return;
          stop();
          enabledWhenPressed = !allow.disabled;
          fireEvent.click(allow);
          resolve();
        });
        app.daemon.refuseConnections(true);
      }),
  );
  expect(enabledWhenPressed).toBe(true);
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Allow once" }).disabled).toBe(
      true,
    ),
  );
  expect(app.daemon.isPending("thread-checkout", "approve-clear-cache")).toBe(true);
  act(() => app.daemon.refuseConnections(false));
  act(() => app.client.reconnectNow());
  await waitFor(() => expect(app.client.state).toBe("ready"));
  expect(app.daemon.isPending("thread-checkout", "approve-clear-cache")).toBe(true);
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

test("words sent as a reply in the instant the connection drops never become the answer", async () => {
  const { app } = slowDaemon();
  app.play(asksIndentation()).runUntilBlocked();
  await app.open("/t/thread-indent");
  await screen.findByRole("article", { name: "Tabs or Spaces?" });
  const message = screen.getByRole("combobox", { name: "Message" });
  await userEvent.type(message, "Two spaces");
  // Enter starts the reply (its sender loads while it waits); the connection drops meanwhile.
  act(() => {
    fireEvent.keyDown(message, { key: "Enter" });
    app.daemon.refuseConnections(true);
  });
  expect(await screen.findByText("Reply not sent")).toBeTruthy();
  await waitFor(() => expect(message.textContent).toBe("Two spaces"));
  act(() => app.daemon.refuseConnections(false));
  act(() => app.client.reconnectNow());
  await waitFor(() => expect(app.client.state).toBe("ready"));
  expect(app.daemon.isPending("thread-indent", "indent")).toBe(true);
});
