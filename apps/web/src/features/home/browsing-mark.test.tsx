import { coldStartReplay, seedPanels } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const threadId = "thread-cold-start";
beforeEach(() => localStorage.clear());

test("a thread's row shows a quiet browsing mark while an agent works in its browser, and loses it when the agent stops", async () => {
  const app = harness();
  const scenario = coldStartReplay();
  app.play(scenario).step();
  await app.open("/");
  const nav = await screen.findByRole("navigation", { name: "Threads" });
  const row = await within(nav).findByRole("link", { name: new RegExp(scenario.thread.title) });
  expect(within(row).queryByRole("img", { name: "An agent is browsing" })).toBeNull();

  // The agent opens the thread's browser in the background and works in it.
  act(() => seedPanels(app.daemon, threadId));
  await waitFor(() =>
    expect(within(row).getByRole("img", { name: "An agent is browsing" })).toBeTruthy(),
  );

  act(() => app.daemon.browser.agentIdle(threadId));
  await waitFor(() =>
    expect(within(row).queryByRole("img", { name: "An agent is browsing" })).toBeNull(),
  );
});
