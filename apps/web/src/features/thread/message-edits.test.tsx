import { facts } from "@ace/fake-daemon";
import type { ProviderKind } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const answer = (item: string, text: string, nativeId: string) => ({
  type: "item.upsert" as const,
  agent: "root",
  item,
  draft: {
    type: "message" as const,
    role: "assistant" as const,
    complete: true,
    nativeId,
    parts: [{ type: "text" as const, text }],
  },
});

/** Two finished turns: "Plan the change" → first answer, "Use the other approach" → second. */
async function twoTurns(provider: ProviderKind) {
  const app = harness();
  const id = `edits-${provider}`;
  app.daemon.createThread({ id, workspaceId: "ace", title: "Edits", provider });
  app.daemon.apply(id, [
    facts.rootAgent(provider),
    facts.turn("root"),
    facts.message("root", "ask-1", "user", "Plan the change"),
    answer("answer-1", "Here is the plan.", "entry-1"),
    facts.endTurn("root"),
    facts.turn("root"),
    facts.message("root", "ask-2", "user", "Use the other approach"),
    answer("answer-2", "Switched approaches.", "entry-2"),
    facts.endTurn("root"),
  ]);
  await app.open(`/t/${id}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Switched approaches.");
  return { app, feed };
}

test("on Pi, Edit goes back to before the message and puts its text in the composer", async () => {
  const { feed } = await twoTurns("pi");
  // The thread's first message has nothing before it to go back to: only the second offers Edit.
  const edits = await within(feed).findAllByRole("button", { name: "Edit message" });
  expect(edits).toHaveLength(1);
  const edit = edits[0];
  if (!edit) throw new Error("No Edit");
  await userEvent.click(edit);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toContain(
      "Use the other approach",
    ),
  );
});

test("on Pi, Retry asks the last question again from before it, only on the newest answer", async () => {
  const { feed } = await twoTurns("pi");
  const retries = await within(feed).findAllByRole("button", { name: "Retry" });
  expect(retries).toHaveLength(1);
  const retry = retries[0];
  if (!retry) throw new Error("No Retry");
  await userEvent.click(retry);
  await waitFor(() =>
    expect(within(feed).getAllByText("Use the other approach").length).toBeGreaterThan(1),
  );
});

test("elsewhere, Edit opens a fork from the turn before with the message to change, and there is no Retry", async () => {
  const { feed } = await twoTurns("codex");
  expect(within(feed).queryByRole("button", { name: "Retry" })).toBeNull();
  const edit = (await within(feed).findAllByRole("button", { name: "Edit message" }))[0];
  if (!edit) throw new Error("No Edit");
  await userEvent.click(edit);
  const dialog = await screen.findByRole("dialog", { name: "Edit message" });
  const first = within(dialog).getByRole("textbox", { name: "First message of the fork" });
  expect(first).toHaveProperty("value", "Use the other approach");
});
