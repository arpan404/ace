import { flakyCheckout } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("after a dropped connection the transcript catches up by replay, without duplicates", async () => {
  const app = harness();
  const script = app.play(flakyCheckout());
  script.runThrough("explorer-spawned");
  await app.open("/w/acme-web/t/thread-checkout");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("I'll look for timing assumptions in the checkout flow first.");

  // Every frame now arrives twice, and work continues while the socket is down.
  app.daemon.duplicateEvents = true;
  await act(async () => {
    app.daemon.disconnectAll();
    script.runThrough("watcher-started");
  });
  await within(feed).findByText(/The payment poller retries/);
  await within(feed).findByText("Run checkout tests in watch mode");

  // Live delivery after the reconnect is duplicated too.
  await act(async () => script.runThrough("approval-requested"));
  await within(feed).findByText("Clear the test cache");

  for (const text of [
    /checkout.spec.ts fails about one run in five/,
    "I'll look for timing assumptions in the checkout flow first.",
    /The payment poller retries/,
    "Explore checkout timing",
    "Run checkout tests in watch mode",
  ])
    expect(within(feed).getAllByText(text)).toHaveLength(1);
  // ask, plan, spawn, search, finding, watcher, approval call
  expect(within(feed).getAllByRole("article")).toHaveLength(7);
  expect(screen.getByRole("status", { name: "Daemon: Connected" })).toBeTruthy();
});
