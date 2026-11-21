import { createMemoryHistory } from "@tanstack/react-router";
import { act, configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Transfer } from "@ace/protocol";
import { beforeEach, expect, test } from "vitest";
import { linkedMachines, strip, workspace } from "./transfer-fixture.tsx";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** The thread's move to Studio, handed over, waiting on a Studio this Mac no longer links. */
const stranded = Transfer.parse({
  transferId: "transfer-stranded",
  commandId: "command-stranded",
  kind: "thread",
  workspaceId: workspace.id,
  threadId: "thread-forecast",
  target: { hostId: "studio", name: "Studio" },
  phase: "importing",
  unlinked: true,
  method: "bundle",
  sentBytes: 10,
  totalBytes: 10,
  live: { stage: "handing" },
  startedAt: 1,
  updatedAt: 1,
});

async function strandedMove() {
  const history = createMemoryHistory({ initialEntries: ["/t/thread-forecast"] });
  const fixture = linkedMachines({ history });
  await fixture.app.open("/t/thread-forecast");
  act(() => fixture.app.daemon.transfers.seed(stranded));
  expect(await strip("This thread is moving to Studio, which isn't linked any more")).toBeTruthy();
  return { ...fixture, history };
}

test("a move waiting on a machine that isn't linked says so, and Link Studio again opens the fleet", async () => {
  const { history } = await strandedMove();
  await userEvent.click(screen.getByRole("button", { name: "Link Studio again" }));
  await waitFor(() => expect(history.location.pathname).toBe("/settings/remote"));
}, 30_000);

test("Carry on here anyway warns that both may run before it carries the thread on here", async () => {
  const { app } = await strandedMove();
  await userEvent.click(screen.getByRole("button", { name: "Carry on here anyway" }));
  expect(
    await strip("If Studio already took the thread, both may run. Carry on here?"),
  ).toBeTruthy();
  // Nothing was done yet: Keep waiting leaves the move as it is.
  expect(app.daemon.transfers.list()[0]?.phase).toBe("importing");
  await userEvent.click(screen.getByRole("button", { name: "Keep waiting" }));
  await userEvent.click(await screen.findByRole("button", { name: "Carry on here anyway" }));
  await userEvent.click(await screen.findByRole("button", { name: "Carry on here" }));
  await waitFor(() =>
    expect(app.daemon.transfers.list()[0]).toMatchObject({
      phase: "cancelled",
      error: { code: "carried_on_here" },
    }),
  );
}, 30_000);
