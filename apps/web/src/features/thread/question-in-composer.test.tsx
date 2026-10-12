import type { Scenario } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { answerStore } from "@/features/thread/interactions/answers.ts";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
afterEach(() => answerStore.forgetAll());

const threadId = "thread-indent";

/** A Codex thread whose agent asks one question that takes a typed answer, and waits. */
function asksIndentation(): Scenario {
  return {
    thread: { id: threadId, workspaceId: "relay", title: "Indentation", provider: "codex" },
    steps: [
      {
        kind: "facts",
        facts: [
          {
            type: "agent.seen",
            agent: "root",
            origin: "root",
            fidelity: "full",
            native: { provider: "codex", nativeId: "root" },
            cwd: "/Users/dev/relay",
          },
          { type: "turn.started", agent: "root", nativeTurnId: "t1", trigger: "user" },
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

async function openQuestion() {
  const app = harness();
  app.play(asksIndentation()).runUntilBlocked();
  await app.open(`/t/${threadId}`);
  const region = await screen.findByRole("region", { name: "Waiting for you" });
  const card = await within(region).findByRole("article", { name: "Tabs or Spaces?" });
  return { app, card, message: screen.getByRole("combobox", { name: "Message" }) };
}

test("Something else is a field on the card: typing there picks it, and Continue sends the words", async () => {
  const { app, card, message } = await openQuestion();
  const go = within(card).getByRole("button", { name: "Continue" });
  expect(go.hasAttribute("disabled")).toBe(true);

  await userEvent.type(
    within(card).getByRole("textbox", { name: /^Something else/ }),
    "Two spaces, like the rest of the repo",
  );
  expect(within(card).getByRole("radio", { name: "Something else", checked: true })).toBeTruthy();
  await userEvent.click(within(card).getByRole("button", { name: "Continue" }));

  await waitFor(() =>
    expect(app.daemon.resolution(threadId, "indent")).toEqual({
      kind: "question",
      answers: { style: ["Two spaces, like the rest of the repo"] },
    }),
  );
  // The message was never the answer: it is still empty and nothing queued.
  expect(message.textContent).toBe("");
  expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull();
});

test("Enter in the Something else field continues", async () => {
  const { app, card } = await openQuestion();
  await userEvent.type(
    within(card).getByRole("textbox", { name: /^Something else/ }),
    "Whatever the formatter says{Enter}",
  );
  await waitFor(() =>
    expect(app.daemon.resolution(threadId, "indent")).toEqual({
      kind: "question",
      answers: { style: ["Whatever the formatter says"] },
    }),
  );
});

test("the message stays a message while a question is open, and Stop waits", async () => {
  const { app, message } = await openQuestion();
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
  await userEvent.type(message, "Use whatever the repo already does{Enter}");
  await screen.findByRole("list", { name: "Queued messages" });
  expect(app.daemon.isPending(threadId, "indent")).toBe(true);
});

test("picking an option enables Continue, which sends the selected option", async () => {
  const { app, card } = await openQuestion();
  await userEvent.click(within(card).getByRole("radio", { name: "Spaces" }));
  await userEvent.click(within(card).getByRole("button", { name: "Continue" }));

  await waitFor(() =>
    expect(app.daemon.resolution(threadId, "indent")).toEqual({
      kind: "question",
      answers: { style: ["spaces"] },
    }),
  );
});
