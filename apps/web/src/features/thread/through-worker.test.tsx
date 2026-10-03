import { flakyCheckout } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

test("with the client behind the worker port, a thread streams in and an approval goes back", async () => {
  const app = harness({ throughWorker: true });
  const script = app.play(flakyCheckout());
  script.step();
  await app.open("/t/thread-checkout");
  await screen.findByRole("feed", { name: "Transcript" });
  // Everything below arrives as forwarded store changes after the screen is open.
  script.runThrough("approval-requested");
  const card = await screen.findByRole("article", {
    name: "Run rm -rf node_modules/.cache/vitest?",
  });
  await userEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    expect(app.daemon.resolution("thread-checkout", "approve-clear-cache")).toEqual({
      kind: "approval",
      optionId: "allow",
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("article", { name: "Run rm -rf node_modules/.cache/vitest?" }),
    ).toBeNull(),
  );
});
