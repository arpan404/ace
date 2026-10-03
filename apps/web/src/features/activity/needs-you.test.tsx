import { flakyCheckout } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const approvalTitle = "Run rm -rf node_modules/.cache/vitest?";

test("answering an approval in Activity resolves it and clears the rail's needs-you count", async () => {
  const app = harness();
  app.play(flakyCheckout()).runThrough("approval-requested");
  await app.open("/activity");

  const card = await screen.findByRole("article", { name: approvalTitle });
  const rail = screen.getByRole("navigation", { name: "Views" });
  expect(within(rail).getByLabelText("1 need you")).toBeTruthy();

  await userEvent.click(within(card).getByRole("button", { name: "Allow once" }));

  await waitFor(() => expect(screen.queryByRole("article", { name: approvalTitle })).toBeNull());
  expect(await screen.findByText("Nothing needs you")).toBeTruthy();
  expect(within(rail).queryByLabelText(/need you/)).toBeNull();

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
