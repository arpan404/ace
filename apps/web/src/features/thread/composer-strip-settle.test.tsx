import { facts, longHistory } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const id = "thread-router";

/** What the composer's strip shows: its kind, or nothing. */
function stripKind(): string {
  const strip = document.querySelector("[data-composer-strip]");
  if (!strip) return "none";
  return strip.querySelector("[data-slot-kind]")?.getAttribute("data-slot-kind") ?? "?";
}

/** Every kind the strip shows from now on, in order, each once in a row. */
function watchStrip() {
  const seen = [stripKind()];
  const observer = new MutationObserver(() => {
    const kind = stripKind();
    if (seen.at(-1) !== kind) seen.push(kind);
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true });
  return { seen, stop: () => observer.disconnect() };
}

test("a message sent before the turn starts doesn't flash the queue in the strip on its way in", async () => {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  // The daemon takes the message into its queue and starts the turn a moment later.
  app.daemon.holdQueue(id, "manual");
  await app.open(`/t/${id}`);
  await screen.findByRole("feed", { name: "Transcript" });
  const message = await screen.findByRole("combobox", { name: "Message" });
  const strip = watchStrip();

  await userEvent.type(message, "continue{Enter}");
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Another device resumes the queue: the turn starts.
  const lease = app.client.thread(id);
  const revision = lease.store.queue?.revision ?? 0;
  lease.release();
  await act(() =>
    app.client.command({
      type: "thread.resume",
      threadId: ThreadId.parse(id),
      expectedRevision: revision,
    }),
  );
  // Past the hold's two-second limit, so a hold that never let go would show here too.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  strip.stop();
  // One state throughout: the strip never switched while the send settled.
  expect(strip.seen).toEqual(["none"]);
});

test("a send whose turn doesn't start lets the strip show what is current after a moment", async () => {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  app.daemon.holdQueue(id, "manual");
  await app.open(`/t/${id}`);
  await screen.findByRole("feed", { name: "Transcript" });
  const message = await screen.findByRole("combobox", { name: "Message" });

  await userEvent.type(message, "continue{Enter}");
  // The queue stays paused, so the turn never runs: the strip says so once the hold is up.
  await waitFor(() => expect(stripKind()).toBe("queue"), { timeout: 4_000 });
  expect(screen.getByText("Queue paused")).toBeTruthy();
});

/** An idle thread whose queue holds what's sent, so a send would sit in the strip's hold. */
async function heldSend() {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  app.daemon.holdQueue(id, "manual");
  await app.open(`/t/${id}`);
  await screen.findByRole("feed", { name: "Transcript" });
  const message = await screen.findByRole("combobox", { name: "Message" });
  return { app, message };
}

/** Well inside the hold's two seconds: what must show at once shows by then. */
const atOnce = { timeout: 1_000 };

test("an approval that arrives while a send settles shows at once", async () => {
  const { app, message } = await heldSend();
  await userEvent.type(message, "continue{Enter}");
  act(() =>
    app.daemon.apply(id, [
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "approve-run",
        blocking: true,
        request: {
          kind: "approval",
          title: "Run bun test?",
          options: [
            { id: "allow", label: "Allow once", kind: "allow_once" },
            { id: "deny", label: "Deny", kind: "deny" },
          ],
        },
      },
    ]),
  );
  await waitFor(() => expect(stripKind()).toBe("request"), atOnce);
});

test("a lost connection while a send settles shows at once", async () => {
  const { app, message } = await heldSend();
  await userEvent.type(message, "continue{Enter}");
  act(() => app.client.networkOnline(false));
  await waitFor(() => expect(stripKind()).toBe("connection"), atOnce);
});

test("a send that fails shows Retry at once instead of being held", async () => {
  const { app, message } = await heldSend();
  app.daemon.refuseCommands("thread_busy", "thread.send");
  await userEvent.type(message, "continue{Enter}");
  await waitFor(() => expect(stripKind()).toBe("sending"), atOnce);
  expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
});

test("a message sent while a turn runs shows in the queue at once", async () => {
  const running = "thread-running";
  const app = harness();
  app
    .play({
      thread: { id: running, title: "Replay cursor", workspaceId: "ace", provider: "codex" },
      steps: [
        {
          kind: "facts",
          facts: [
            facts.rootAgent("codex"),
            facts.turn("root"),
            facts.message("root", "ask", "user", "Check the replay cursor."),
            facts.tool("root", "build", {
              kind: "shell",
              title: "bun run build",
              detail: { kind: "shell", command: "bun run build" },
            }),
          ],
        },
      ],
    })
    .runUntilBlocked();
  await app.open(`/t/${running}`);
  await screen.findByRole("feed", { name: "Transcript" });
  const message = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(message, "Check mobile next.{Enter}");
  await waitFor(() => expect(stripKind()).toBe("queue"), atOnce);
});
