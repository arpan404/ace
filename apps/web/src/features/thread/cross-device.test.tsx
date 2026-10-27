import { crossDevice, facts, ScenarioPlayer } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });
beforeEach(() => localStorage.clear());
afterEach(cleanup);

test("a child delegated to a machine this window can't reach names that machine and stays out of local navigation", async () => {
  const app = harness();
  app.play(crossDevice()).runUntilBlocked();
  await app.open("/t/thread-cross-device");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const row = await within(feed).findByRole("button", { name: /^GPU build review on Studio/ });
  expect(row.textContent).toContain("on Studio");
  // Its thread lives on the Studio, which this window isn't paired with: no link into a thread.
  expect(within(feed).queryByRole("link", { name: /GPU build review/ })).toBeNull();
  await waitFor(() => expect(feed.textContent).toContain("staging.relay.dev"));
  expect(feed.textContent).toContain("On studio, ");
});

test("a child delegated to a paired machine opens in its parent's thread as its subagent", async () => {
  const history = createMemoryHistory({ initialEntries: ["/t/thread-cross-device"] });
  const app = harness({ machines: [{ hostId: "studio", name: "Studio" }], history });
  app.play(crossDevice()).runUntilBlocked();
  const studio = app.machines.get("studio");
  if (!studio) throw new Error("no Studio");
  // The child's own thread, on the Studio, under the id its parent recorded.
  new ScenarioPlayer(studio, {
    thread: {
      id: "machine-studio-review",
      workspaceId: "relay",
      title: "GPU build review",
      provider: "codex",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("codex", "/Users/dev/relay"),
          facts.turn("root"),
          facts.message("root", "found", "assistant", "Two benchmarks regressed on the GPU build."),
        ],
      },
    ],
  }).runUntilBlocked();
  await app.open("/t/thread-cross-device");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.click(
    await within(feed).findByRole("link", { name: /^Open GPU build review on Studio/ }),
  );

  await screen.findByRole("heading", { level: 1, name: "GPU build review" });
  expect(decodeURIComponent(history.location.pathname)).toBe(
    "/t/thread-cross-device/agents/machine-studio-review",
  );
  const child = await screen.findByRole("feed", { name: "Transcript" });
  await within(child).findByText(/Two benchmarks regressed/);
  // The header reads `parent / child`: no machine before them.
  const banner = within(screen.getByRole("banner"));
  const parent = banner.getByRole("link", { name: "Check the 0.9 build on the Studio" });
  expect(banner.queryByText("Studio")).toBeNull();

  await userEvent.click(parent);
  await screen.findByRole("heading", { level: 1, name: "Check the 0.9 build on the Studio" });
  expect(decodeURIComponent(history.location.pathname)).toBe("/t/thread-cross-device");
});
