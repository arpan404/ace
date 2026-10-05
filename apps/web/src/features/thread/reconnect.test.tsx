import { flakyCheckout } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("after a dropped connection the transcript catches up by replay, without duplicates", async () => {
  const app = harness();
  const script = app.play(flakyCheckout());
  script.runThrough("explorer-spawned");
  await app.open("/t/thread-checkout");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("I'll look for timing assumptions in the checkout flow first.");

  // Every frame now arrives twice, and work continues while the socket is down.
  app.daemon.duplicateEvents = true;
  await act(async () => {
    app.daemon.disconnectAll();
    script.runThrough("watcher-started");
  });
  await within(feed).findByText(/The payment poller retries/);
  await within(feed).findByText("bun run test --watch checkout");

  // Live delivery after the reconnect is duplicated too.
  await act(async () => script.runThrough("approval-requested"));
  await within(feed).findByText("rm -rf node_modules/.cache/vitest");

  for (const text of [
    /checkout.spec.ts fails about one run in five/,
    "I'll look for timing assumptions in the checkout flow first.",
    /The payment poller retries/,
    "Started 1 subagent",
    "bun run test --watch checkout",
  ])
    expect(within(feed).getAllByText(text)).toHaveLength(1);
  // ask, plan, subagents line, search, finding, watcher, approval call
  expect(within(feed).getAllByRole("article")).toHaveLength(7);
  expect(
    screen.getAllByRole("article", { name: "Run rm -rf node_modules/.cache/vitest?" }),
  ).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Account and connection" })).toBeTruthy();
});
