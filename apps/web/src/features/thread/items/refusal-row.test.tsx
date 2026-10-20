import { ClientProvider } from "@ace/client-react";
import { FakeDaemon, ScenarioPlayer, refusedDelegation } from "@ace/fake-daemon";
import { render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { fakeClient } from "@/test/fake-client.ts";
import { EventBlock } from "./event-divider.tsx";

test("three identical delegation refusals read as one failed row with ×3 and the reason once, in a person's words", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const scenario = refusedDelegation("refused");
  new ScenarioPlayer(daemon, scenario).runUntilBlocked();
  const client = fakeClient(daemon);
  await client.start();
  const lease = client.thread("refused");
  await waitFor(() => expect(lease.store.order.length).toBeGreaterThan(6));
  const notices = lease.store.order.filter((id) => lease.store.item(id)?.type === "notice");
  expect(notices).toHaveLength(3);
  render(
    <ClientProvider client={client}>
      <TooltipProvider>
        {notices.map((id) => (
          <EventBlock key={id} threadId="refused" itemId={id} />
        ))}
      </TooltipProvider>
    </ClientProvider>,
  );
  const rows = await screen.findAllByRole("group", { name: /^Delegation refused/ });
  expect(rows).toHaveLength(1);
  expect(screen.getByText("×3")).toBeTruthy();
  expect(screen.getAllByText("The new agent would have more access than this thread")).toHaveLength(
    1,
  );
  // What the daemon told the agent stays with the agent.
  expect(screen.queryByText(/Allowed claude modes/)).toBeNull();
  expect(screen.queryByText(/Child permissions exceed/)).toBeNull();
  expect(screen.queryByRole("button", { name: /Details/ })).toBeNull();
  lease.release();
});
