import { longHistory, replayCursor } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { chooseModel } from "@/test/model-control.ts";

beforeEach(() => localStorage.clear());

async function openRouter() {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  await app.open("/t/thread-router");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  return { app, feed };
}

const thread = (app: ReturnType<typeof harness>, id: string) => {
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(id) });
  return view?.kind === "thread" ? view.thread : undefined;
};

test("forking from an answer opens a new thread that starts with the person's message", async () => {
  const { app, feed } = await openRouter();
  await within(feed).findByText(/Answer 1: route 1/);
  const forkHere = within(feed).getAllByRole("button", { name: "Fork from here" })[0];
  if (!forkHere) throw new Error("No finished answer to fork");
  await userEvent.click(forkHere);
  const dialog = await screen.findByRole("dialog", { name: "Fork from here" });
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: "First message of the fork" }),
    "Try nested routes instead",
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Fork" }));

  await screen.findByRole("heading", { level: 1, name: "Document the router (fork)" });
  const forked = Object.values(
    (() => {
      const view = app.daemon.snapshot({ kind: "threads" });
      return view?.kind === "threads" ? view.threads : {};
    })(),
  ).find((entry) => entry.lineage?.parentThreadId === "thread-router");
  expect(forked?.lineage?.point.type).toBe("turn");
  expect(
    await within(await screen.findByRole("feed", { name: "Transcript" })).findByText(
      "Try nested routes instead",
    ),
  ).toBeTruthy();
  // The source thread is untouched.
  expect(thread(app, "thread-router")?.status.state).toBe("done");
});

test("the ⋯ menu forks from the last finished turn", async () => {
  await openRouter();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Fork from the last turn…" }));
  expect(await screen.findByRole("dialog", { name: "Fork from here" })).toBeTruthy();
});

test("picking another provider's model asks first, then switches after the running turn", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  await chooseModel("GPT-5 Codex", "Codex", /^Model: Opus 5.5/);

  const dialog = await screen.findByRole("dialog", { name: "Switch to Codex?" });
  expect(within(dialog).getByText(/doesn't carry over/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: /^Switch to/ }));
  expect(await screen.findByText(/Next turn runs on Codex · Personal/)).toBeTruthy();
  expect(thread(app, "thread-replay-cursor")?.switch).toMatchObject({
    state: "queued",
    selection: { provider: "codex" },
  });
  // The picker already shows where the next turn runs.
  expect(await screen.findByRole("button", { name: /^Model: GPT-5 Codex/ })).toBeTruthy();
});

test("deleting from the ⋯ menu leaves the thread and persists deletion immediately", async () => {
  const { app } = await openRouter();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete thread" }));
  await waitFor(() => expect(screen.queryByRole("feed", { name: "Transcript" })).toBeNull());
  expect(await screen.findByText("Deleted · Document the router")).toBeTruthy();
  await waitFor(() => expect(thread(app, "thread-router")).toBeUndefined(), { timeout: 9_000 });
}, 15_000);

test("a thread with work running can't be deleted, and says why", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Delete thread" }));
  expect(
    await screen.findByText(/^Still running: \d+ agents?\.$/, undefined, { timeout: 9_000 }),
  ).toBeTruthy();
  expect(thread(app, "thread-replay-cursor")).toBeDefined();
}, 15_000);

test("pinning from the ⋯ menu pins the thread on the daemon", async () => {
  const { app } = await openRouter();
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Pin/ }));
  await waitFor(() => expect(thread(app, "thread-router")?.pinned).toBe(true));
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(await screen.findByRole("menuitem", { name: /^Unpin/ })).toBeTruthy();
});
