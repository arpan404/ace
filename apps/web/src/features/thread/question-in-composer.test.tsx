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

test("Something else puts the caret in the message, whose text is then the answer", async () => {
  const { app, card, message } = await openQuestion();
  // While the question is open, the send button answers it; nothing is picked or typed yet.
  const send = screen.getByRole("button", { name: "Answer" });
  expect(send.getAttribute("aria-disabled")).toBe("true");

  await userEvent.click(within(card).getByRole("radio", { name: "Something else" }));
  expect(document.activeElement).toBe(message);
  // No second answer field inside the card: the message is where the answer goes.
  expect(within(card).queryByRole("textbox")).toBeNull();

  await userEvent.keyboard("Two spaces, like the rest of the repo");
  await userEvent.click(screen.getByRole("button", { name: "Answer" }));

  await waitFor(() =>
    expect(app.daemon.resolution(threadId, "indent")).toEqual({
      kind: "question",
      answers: { style: ["Two spaces, like the rest of the repo"] },
    }),
  );
  // The text went as the answer, not as a message: the composer is empty and nothing queued.
  await waitFor(() => expect((message as HTMLTextAreaElement).value).toBe(""));
  expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull();
});

test("typing in the message while a question is open answers it with Enter, instead of queueing", async () => {
  const { app, card, message } = await openQuestion();
  await userEvent.click(message);
  await userEvent.keyboard("Whatever the formatter says");

  // Typing picks "Something else" on the card, so what is checked is what is sent.
  await waitFor(() =>
    expect(
      (within(card).getByRole("radio", { name: "Something else" }) as HTMLInputElement).checked,
    ).toBe(true),
  );
  expect(screen.getByRole("button", { name: "Answer" }).getAttribute("aria-disabled")).toBeNull();
  await userEvent.keyboard("{Enter}");

  await waitFor(() =>
    expect(app.daemon.resolution(threadId, "indent")).toEqual({
      kind: "question",
      answers: { style: ["Whatever the formatter says"] },
    }),
  );
  expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull();
});

test("picking an option turns the send button into Submit, which sends the option", async () => {
  const { app, card } = await openQuestion();
  await userEvent.click(within(card).getByRole("radio", { name: "Spaces" }));
  await userEvent.click(await screen.findByRole("button", { name: "Submit" }));

  await waitFor(() =>
    expect(app.daemon.resolution(threadId, "indent")).toEqual({
      kind: "question",
      answers: { style: ["spaces"] },
    }),
  );
});
