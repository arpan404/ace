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

test("a person's message shows its time and Copy under the bubble, and offers no Edit", async () => {
  const { feed } = await twoTurns("pi");
  const bubble = within(feed).getByText("Use the other approach");
  expect(within(feed).queryByRole("button", { name: "Edit message" })).toBeNull();
  const copies = within(feed).getAllByRole("button", { name: "Copy message" });
  // The actions follow the bubble in the document, under it rather than beside it.
  const copy = copies.at(-1);
  if (!copy) throw new Error("No Copy");
  expect(bubble.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

test("elsewhere there is no Retry", async () => {
  const { feed } = await twoTurns("codex");
  expect(within(feed).queryByRole("button", { name: "Retry" })).toBeNull();
});
