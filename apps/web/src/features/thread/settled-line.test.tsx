import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

// The workbench's Codex bump: its PR is merged, so settle-on-merge would settle it by itself.
const id = "thread-bump-codex";

async function openSettledThread() {
  const app = harness();
  await app.client.start();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.client.command({ type: "thread.settle", threadId: ThreadId.parse(id) });
  await app.open(`/t/${id}`);
  return app;
}

/** The line under the transcript, not the sidebar's "Settled (n)" section. */
const settledLine = /^Settled (just now|\d+[smhdw] ago)$/;

function thread(app: ReturnType<typeof harness>) {
  const view = app.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads[id] : undefined;
}

test("a settled thread ends with when it settled, and Unsettle keeps it unsettled even with its PR merged", async () => {
  const app = await openSettledThread();
  const line = await screen.findByText(settledLine);
  const row = line.parentElement;
  if (!row) throw new Error("No settled line");
  await userEvent.click(within(row).getByRole("button", { name: "Unsettle" }));
  await waitFor(() => expect(screen.queryByText(settledLine)).toBeNull());
  // The daemon's settle rules run again: the merged PR must not settle it a second time.
  app.daemon.sweep();
  expect(thread(app)?.settledAt).toBeUndefined();
  expect(thread(app)?.autoSettle).toBe(false);
  expect(screen.queryByText(settledLine)).toBeNull();
});

test("turning auto-settle back on from the thread's menu lets its merged PR settle it", async () => {
  const app = await openSettledThread();
  const line = await screen.findByText(settledLine);
  const row = line.parentElement;
  if (!row) throw new Error("No settled line");
  await userEvent.click(within(row).getByRole("button", { name: "Unsettle" }));
  await waitFor(() => expect(thread(app)?.autoSettle).toBe(false));
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Turn on auto-settle/ }));
  await waitFor(() => expect(thread(app)?.autoSettle).toBeUndefined());
  app.daemon.sweep();
  expect(thread(app)?.settledReason).toBe("pr_merged");
  expect(await screen.findByText(settledLine)).toBeTruthy();
});
