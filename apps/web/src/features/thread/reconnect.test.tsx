import { flakyCheckout, facts } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openWorkLog } from "@/test/open-work-log.ts";

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

  await within(feed).findByText("bun run test --watch checkout");

  // Live delivery after the reconnect is duplicated too.
  await act(async () => script.runThrough("approval-requested"));
  await screen.findByRole("article", { name: "Run rm -rf node_modules/.cache/vitest?" });
  expect(within(feed).queryByText("rm -rf node_modules/.cache/vitest")).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Deny" }));
  act(() =>
    app.daemon.apply("thread-checkout", [
      { type: "background.ended", task: "watcher", status: "stopped" },
      facts.toolDone("root", "watch"),
      facts.endTurn("root"),
    ]),
  );
  await openWorkLog(feed);
  // The settled log preserves each replayed step and message once.
  await within(feed).findByText("I'll look for timing assumptions in the checkout flow first.");
  for (const text of [
    /checkout.spec.ts fails about one run in five/,
    "I'll look for timing assumptions in the checkout flow first.",
    /The payment poller retries/,
    "1 subagent",
    "bun run test --watch checkout",
  ])
    expect(within(feed).getAllByText(text)).toHaveLength(1);
  // The ask, the turn's one log (the plan, the search, the finding and the approval call, in
  // order), the subagents line and the watcher.
  expect(within(feed).queryAllByRole("link", { name: "Waiting for your approval" })).toHaveLength(
    0,
  );
  expect(
    screen.queryByRole("article", { name: "Run rm -rf node_modules/.cache/vitest?" }),
  ).toBeNull();
  expect(within(feed).getByRole("note").textContent).toContain("Denied:");
  expect(screen.getByRole("button", { name: /^Model:/ })).toBeTruthy();
});
