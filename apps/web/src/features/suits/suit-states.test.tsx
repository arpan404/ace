import { workbench, workbenchServices } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, test } from "vitest";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs.tsx";
import { WordChoice } from "@/components/ui/word-choice.tsx";
import { harness } from "@/test/harness.tsx";

/*
 * A Suit draws its cursor from `data-state` (ADR 0150, docs/design/suit-parts.md):
 * `[data-part=thread-row][data-state=active]::before { content: "▶" }`. These tests move the
 * selection the way a person does and fail when the state stays behind on the old row, place or tab.
 */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/** The text of every element that is `part` in `state`. */
function inState(part: string, state: string, root: ParentNode = document): string[] {
  return [...root.querySelectorAll(`[data-part="${part}"][data-state="${state}"]`)].map(
    (element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "",
  );
}

/** Skills' rows in the sidebar. */
const skillRows = () => [
  ...document.querySelectorAll<HTMLElement>('[data-part="nav-item"][href^="/skills/"]'),
];

/** The design's daemon at `path`, with a history the test moves. */
async function open(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const app = harness({ clock: () => Date.now(), history });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now(), "UTC"));
  app.daemon.skills.seed([]);
  await app.open(path);
  const go = (to: string) => act(() => history.push(to));
  return { app, go };
}

test("the open thread's row is the one active thread row, and it moves with the thread", async () => {
  const { go } = await open("/t/thread-retry-budget");
  const list = await screen.findByRole("list", { name: "Projects" });
  await waitFor(() => expect(inState("thread-row", "active", list)).toHaveLength(1));
  const first = list.querySelector('[data-part="thread-row"][data-state="active"]');
  expect(first?.getAttribute("href")).toContain("thread-retry-budget");
  go("/t/thread-refund-tax");
  await waitFor(() => {
    const active = [...list.querySelectorAll('[data-part="thread-row"][data-state="active"]')];
    expect(active.map((row) => row.getAttribute("href") ?? "")).toEqual([
      expect.stringContaining("thread-refund-tax"),
    ]);
  });
});

test("the open Settings page is the one active nav item, following the route", async () => {
  const { go } = await open("/settings/agents");
  const nav = await screen.findByRole("navigation", { name: "Settings pages" });
  await waitFor(() => expect(inState("nav-item", "active", nav)).toEqual(["Agents"]));
  go("/settings/appearance");
  await waitFor(() => expect(inState("nav-item", "active", nav)).toEqual(["Appearance"]));
});

test("an open automation and an open skill are the active nav item in their lists", async () => {
  const { go } = await open("/automations/auto-dependency-audit");
  const automations = await screen.findByRole("navigation", { name: "Automation list" });
  await waitFor(() =>
    expect(inState("nav-item", "active", automations).join()).toContain("Nightly dependency audit"),
  );
  go("/skills");
  await screen.findByRole("navigation", { name: "Skills catalog" });
  await waitFor(() => expect(skillRows().length).toBeGreaterThan(1));
  const row = skillRows().find((each) => each.getAttribute("data-state") === null);
  if (!row) throw new Error("Every skill row is active");
  await userEvent.click(row);
  await waitFor(() => expect(row.getAttribute("data-state")).toBe("active"));
  // Only the open skill's row: the one open before is no longer active.
  expect(skillRows().filter((each) => each.getAttribute("data-state") === "active")).toEqual([row]);
});

test("the current place in the rail is its one active item", async () => {
  const { go } = await open("/settings/agents");
  const rail = await screen.findByRole("navigation", { name: "App" });
  await waitFor(() => expect(inState("rail-item", "active", rail)).toEqual(["Settings"]));
  go("/automations");
  await waitFor(() => expect(inState("rail-item", "active", rail)).toEqual(["Automations"]));
});

test("Fleet's open view is its selected tab", async () => {
  const { go } = await open("/settings/remote");
  const views = await screen.findByRole("navigation", { name: "Fleet views" });
  await waitFor(() => expect(inState("tab", "selected", views)).toEqual(["Overview"]));
  go("/settings/remote/map");
  await waitFor(() => expect(inState("tab", "selected", views)).toEqual(["Map"]));
});

function Picks() {
  const [tab, setTab] = useState("changes");
  const [mode, setMode] = useState("light");
  const [view, setView] = useState("open");
  return (
    <>
      <Tabs value={tab} onValueChange={(next: string) => setTab(next)}>
        <TabsList>
          <TabsTab value="changes">Changes</TabsTab>
          <TabsTab value="commits">Commits</TabsTab>
        </TabsList>
        <TabsPanel value="changes">Changed files</TabsPanel>
        <TabsPanel value="commits">Commit list</TabsPanel>
      </Tabs>
      <SegmentedControl
        label="Mode"
        value={mode}
        onValueChange={setMode}
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
      />
      <WordChoice
        label="State"
        value={view}
        onValueChange={setView}
        options={[
          { value: "open", label: "Open" },
          { value: "closed", label: "Closed" },
        ]}
      />
    </>
  );
}

test("tabs, segments and word choices mark the picked one selected, and move with the pick", async () => {
  render(<Picks />);
  expect(inState("tab", "selected")).toEqual(["Changes", "Open"]);
  expect(inState("segment", "selected")).toEqual(["Light"]);
  await userEvent.click(screen.getByRole("tab", { name: "Commits" }));
  await userEvent.click(screen.getByRole("button", { name: "Dark" }));
  await userEvent.click(screen.getByRole("button", { name: "Closed" }));
  expect(inState("tab", "selected")).toEqual(["Commits", "Closed"]);
  expect(inState("segment", "selected")).toEqual(["Dark"]);
  const group = screen.getByRole("group", { name: "Mode" });
  expect(group.getAttribute("data-part")).toBe("segmented");
  expect(within(group).getAllByText(/Light|Dark/)).toHaveLength(2);
});

test("the command palette's scope tabs mark the open scope selected", async () => {
  await open("/settings/agents");
  await screen.findByRole("navigation", { name: "Settings pages" });
  await userEvent.keyboard("{Meta>}k{/Meta}");
  const scopes = await screen.findByRole("tablist", { name: "Search in" });
  const selected = () => inState("tab", "selected", scopes);
  expect(selected()).toHaveLength(1);
  const other = within(scopes)
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("aria-selected") === "false");
  if (!other) throw new Error("One scope only");
  await userEvent.click(other);
  await waitFor(() => expect(selected()).toEqual([other.textContent]));
});
