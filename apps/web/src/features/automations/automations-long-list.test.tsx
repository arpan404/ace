import { flakyCheckout, workbench, workbenchServices } from "@ace/fake-daemon";
import { act, configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { fakeClient } from "@/test/fake-client.ts";
import { harness } from "@/test/harness.tsx";
import { useScrollLayout } from "@/test/scroll-layout.ts";

configure({ asyncUtilTimeout: 10000 });
beforeEach(() => localStorage.clear());
useScrollLayout({ viewport: 400, row: 37 });

// The most each of the person's and the agents' lists carries on the wire: 2,000 in all.
const each = 1_000;
const pad = (n: number) => String(n).padStart(4, "0");

/** The design's daemon with 1,000 automations of the person's and 1,000 agents made. */
async function open() {
  const app = harness({
    clock: () => Date.now(),
    storage: localStorage,
    client: (daemon) => fakeClient(daemon),
  });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  // The thread the agents' automations belong to.
  app.play(flakyCheckout()).runUntilBlocked();
  const seed = workbenchServices(Date.now(), "UTC");
  const [model] = seed.automations ?? [];
  const [made] = seed.threadAutomations ?? [];
  if (!model || !made) throw new Error("The workbench seeds automations");
  seed.automations = Array.from({ length: each }, (_, n) => ({
    ...model,
    id: `auto-bulk-${pad(n + 1)}`,
    title: `Bulk ${pad(n + 1)}`,
  }));
  seed.runs = [];
  seed.threadAutomations = Array.from({ length: each }, (_, n) => ({
    ...made,
    automation: {
      ...made.automation,
      id: `thread-bulk-${pad(n + 1)}`,
      title: `Agent ${pad(n + 1)}`,
    },
  }));
  seed.threadRuns = [];
  app.daemon.seedServices(seed);
  await app.open("/automations");
  const aside = await screen.findByRole("complementary", { name: "Automations" });
  const nav = await within(aside).findByRole("navigation", { name: "Automation list" });
  await within(nav).findByRole("link", { name: /^Bulk 0001/ });
  // The agents' automations are listed once automations run.
  await app.client.request({
    type: "settings.set",
    key: "automations.enabled",
    value: true,
    layer: { kind: "global" },
  });
  return within(nav);
}

test("2,000 automations mount only a window of rows", async () => {
  const list = await open();
  const links = list.getAllByRole("link");
  expect(links.length).toBeGreaterThan(5);
  expect(links.length).toBeLessThan(60);
  expect(list.queryByRole("link", { name: /^Bulk 1000/ })).toBeNull();
  expect(list.getByRole("list", { name: "Automations" })).toBeTruthy();
});

test("End reaches the last automation, under In threads, scrolled into view", async () => {
  const list = await open();
  const first = list.getByRole("link", { name: /^Bulk 0001/ });
  act(() => first.focus());
  fireEvent.keyDown(first, { key: "End" });
  await waitFor(
    () => expect(document.activeElement).toBe(list.getByRole("link", { name: /^Agent 1000/ })),
    { timeout: 15_000 },
  );
  expect(list.queryByRole("link", { name: /^Bulk 0001/ })).toBeNull();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowUp" });
  await waitFor(() =>
    expect(document.activeElement).toBe(list.getByRole("link", { name: /^Agent 0999/ })),
  );
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Home" });
  await waitFor(() =>
    expect(document.activeElement).toBe(list.getByRole("link", { name: /^Bulk 0001/ })),
  );
});

test("searching 2,000 automations finds one far down the list", async () => {
  const list = await open();
  await userEvent.type(screen.getByRole("searchbox", { name: "Search automations" }), "Bulk 0987");
  expect(await list.findByRole("link", { name: /^Bulk 0987/ })).toBeTruthy();
  await waitFor(() => expect(list.getAllByRole("link")).toHaveLength(1));
});
