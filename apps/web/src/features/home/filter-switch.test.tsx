import { workbench } from "@ace/fake-daemon";
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { gatedClient, memoryReadSnapshots, type Gate } from "@/test/gated-client.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";

configure({ asyncUtilTimeout: 10000 });

/*
 * Over a slow link the daemon's list for a new project filter takes a while. The rows the list
 * already holds for that project paint at once, saying "Syncing" (AGENTS.md priority 1: never
 * a status the daemon hasn't confirmed), and no skeleton flashes in between.
 */

const threads = () => screen.getByRole("navigation", { name: "Threads" });
// relay's rows, all in Active: the workbench's waiting approval and running thread, and a quiet
// one added here.
const relay = [
  "Retry budget for app-server restarts",
  "Backpressure on broadcast fan-out",
  "Tidy the relay README",
];
const rowFor = (title: string) => within(threads()).getByRole("link", { name: new RegExp(title) });

/** Whether the list's skeleton was ever put on the page, however briefly, while watching. */
function watchSkeleton(label = "threads") {
  let shown = false;
  const loading = `[aria-label="Loading ${label}"]`;
  const watcher = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes)
        if (node instanceof Element && (node.matches(loading) || node.querySelector(loading)))
          shown = true;
  });
  watcher.observe(document.body, { childList: true, subtree: true });
  return {
    shown() {
      watcher.disconnect();
      return shown;
    },
  };
}

function addQuietRelayThread(app: ReturnType<typeof harness>) {
  createIdleTask(app.daemon, {
    id: "thread-relay-readme",
    workspaceId: "relay",
    title: "Tidy the relay README",
    provider: "codex",
  });
}

async function chooseProject(from: string, to: string) {
  await userEvent.click(screen.getByRole("button", { name: `Project filter: ${from}` }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: to }));
}

test("switching the project filter paints that project's rows at once, syncing until the daemon's list lands", async () => {
  const gate: Gate = { held: false, queue: [] };
  const app = harness({ client: (daemon) => gatedClient(daemon, memoryReadSnapshots(), gate) });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  addQuietRelayThread(app);
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findByRole("link", {
    name: new RegExp(relay[0] ?? ""),
  });
  const skeleton = watchSkeleton();

  gate.held = true;
  await chooseProject("All projects", "relay");
  // Unconfirmed, a row says Syncing in its name and carries no mark: it claims no status yet.
  for (const title of relay) {
    const row = await waitFor(() => rowFor(title));
    expect(row.getAttribute("aria-label")).toContain("Syncing");
    expect(row.querySelector("[data-indicator]")).toBeNull();
  }
  // Only relay's rows paint, though the daemon hasn't answered yet.
  for (const link of within(threads()).getAllByRole("link"))
    expect(link.getAttribute("aria-label")).toContain("Project relay");
  await waitFor(() => expect(gate.queue.length).toBeGreaterThan(0));

  gate.held = false;
  act(() => {
    for (const deliver of gate.queue.splice(0)) deliver();
  });
  await waitFor(() =>
    expect(rowFor(relay[0] ?? "").getAttribute("aria-label")).not.toContain("Syncing"),
  );
  expect(skeleton.shown()).toBe(false);
});

test("a filter whose list arrives quickly never flashes the skeleton, even with no rows to paint first", async () => {
  const storage = memoryKeyValue();
  const first = harness({ storage });
  for (const scenario of workbench()) first.play(scenario).runUntilBlocked();
  addQuietRelayThread(first);
  const view = await first.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  await chooseProject("All projects", "relay");
  await screen.findByRole("button", { name: "Project filter: relay" });
  view.unmount();

  // A new session that has only seen relay: widening to every project has nothing to paint.
  const app = harness({ storage });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  addQuietRelayThread(app);
  await app.open("/");
  await waitFor(() => expect(within(threads()).getAllByRole("link")).toHaveLength(relay.length));
  const skeleton = watchSkeleton();
  await chooseProject("relay", "All projects");
  await waitFor(() =>
    expect(within(threads()).getAllByRole("link").length).toBeGreaterThan(relay.length),
  );
  expect(skeleton.shown()).toBe(false);
});

test("the archive never flashes its skeleton when its list arrives quickly", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const skeleton = watchSkeleton("archived threads");
  await app.open("/archived");
  expect(await screen.findByText("Nothing archived")).toBeTruthy();
  expect(skeleton.shown()).toBe(false);
});
