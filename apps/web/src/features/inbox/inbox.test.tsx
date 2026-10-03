import { flakyCheckout } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const approvalTitle = "Run rm -rf node_modules/.cache/vitest?";

function threadRow(title: RegExp) {
  return within(screen.getByRole("navigation", { name: "Threads" })).getByRole("link", {
    name: title,
  });
}

test("answering an approval in the inbox resolves it and the thread moves from needs you to working", async () => {
  const app = harness();
  app.play(flakyCheckout()).runThrough("approval-requested");
  await app.open("/inbox");

  const card = await screen.findByRole("article", { name: approvalTitle });
  expect(within(threadRow(/Fix flaky checkout test/)).getByText("Needs you")).toBeTruthy();

  await userEvent.click(within(card).getByRole("button", { name: "Allow once" }));

  await waitFor(() => expect(screen.queryByRole("article", { name: approvalTitle })).toBeNull());
  await waitFor(() =>
    expect(within(threadRow(/Fix flaky checkout test/)).getByText("Working")).toBeTruthy(),
  );
  expect(screen.getByText("Nothing needs you")).toBeTruthy();

  // The daemon's interaction.closed event, not the click, is what the store now holds.
  const thread = app.client.thread("thread-checkout");
  const resolved = thread.store
    .interactionIds()
    .map((id) => thread.store.interaction(id))
    .find((interaction) => interaction?.request.kind === "approval");
  thread.release();
  expect(resolved).toMatchObject({
    state: "resolved",
    resolution: { kind: "approval", optionId: "allow" },
    resolvedBy: "test-device",
  });
});
