import type { Fact } from "@ace/core";
import { FakeDaemon } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { gatedClient, memoryReadSnapshots, type Gate } from "@/test/gated-client.ts";
import { harness } from "@/test/harness.tsx";

/*
 * AGENTS.md priority 1: a view painted from a saved record must not claim the status the record
 * had. The thread was done when this device last saw it and is working again now; until the
 * daemon's snapshots arrive the row and the transcript say "Syncing", never Done.
 */

const threadId = "thread-restored";
const title = "Ship the release notes";

function turn(id: string, outcome?: "completed"): Fact[] {
  return [
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      native: { provider: "codex", nativeId: "root" },
      cwd: "/Users/dev/acme",
    },
    { type: "turn.started", agent: "root", nativeTurnId: id, trigger: "user" },
    {
      type: "item.upsert",
      agent: "root",
      item: `${id}-ask`,
      draft: {
        type: "message",
        role: "user",
        complete: true,
        parts: [{ type: "text", text: "Go." }],
      },
    },
    ...(outcome ? [{ type: "turn.ended" as const, agent: "root", nativeTurnId: id, outcome }] : []),
  ];
}

test("a restored thread that was done never shows as done before the daemon confirms it is working", async () => {
  const saved = memoryReadSnapshots();
  let at = Date.now() + 60_000;
  const clock = () => (at = Math.max(at + 1, Date.now() + 60_000));
  const daemon = new FakeDaemon({ clock });
  daemon.createThread({ id: threadId, workspaceId: "ace", title, provider: "codex" });
  daemon.apply(threadId, turn("turn-1", "completed"));

  // Last session: the thread finished, was read, and this device saved what it showed.
  const before = harness({
    daemon,
    clock,
    history: createMemoryHistory({ initialEntries: [`/t/${threadId}`] }),
    client: (shared) => gatedClient(shared, saved),
  });
  await before.open(`/t/${threadId}`);
  await within(await screen.findByRole("feed", { name: "Transcript" })).findByText("Go.");
  const earlier = within(await screen.findByRole("navigation", { name: "Threads" }));
  await waitFor(() =>
    expect(
      earlier
        .getByRole("link", { name: new RegExp(`^${title}`) })
        .closest("[data-attention]")
        ?.getAttribute("data-attention"),
    ).toBe("quiet"),
  );
  await act(() => before.client.close());
  cleanup();

  // Meanwhile it started working again. This session paints from the saved records first.
  daemon.apply(threadId, turn("turn-2"));
  const gate: Gate = { held: true, queue: [] };
  const app = harness({
    daemon,
    clock,
    history: createMemoryHistory({ initialEntries: [`/t/${threadId}`] }),
    client: (shared) => gatedClient(shared, saved, gate),
  });
  await app.open(`/t/${threadId}`);
  const list = within(await screen.findByRole("navigation", { name: "Threads" }));
  const link = await list.findByRole("link", { name: new RegExp(`^${title}`) });
  const row = () => link.closest("[data-attention]");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Go.");
  // Painted from disk while both snapshots wait: syncing, not done.
  await waitFor(() => expect(gate.queue.length).toBeGreaterThan(0));
  expect(row()?.getAttribute("data-attention")).toBe("syncing");
  expect(within(link).getByText("Syncing")).toBeTruthy();
  expect(within(link).queryByText("Done")).toBeNull();
  expect(within(feed).getByText("Syncing…")).toBeTruthy();
  expect(within(feed).queryByText(/^Working/)).toBeNull();

  // The daemon's snapshots land: the thread is working.
  gate.held = false;
  act(() => {
    for (const deliver of gate.queue.splice(0)) deliver();
  });
  await waitFor(() => expect(row()?.getAttribute("data-attention")).toBe("active"));
  expect(within(link).getByText("Working")).toBeTruthy();
  await within(feed).findByText(/^Working/);
  expect(within(feed).queryByText("Syncing…")).toBeNull();
});
