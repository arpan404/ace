import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { act, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * AGENTS.md priority 1: a thread whose first message never went out has nothing running. Its
 * provider session opened, so the root agent still reads as starting, but the daemon reads the
 * thread as failed and holds the message for Try again, Edit or Remove.
 */
test("a start whose first message wasn't sent never reads as working", async () => {
  const app = harness();
  const threadId = ThreadId.parse("thread-refused-start");
  app.daemon.createThread({
    id: threadId,
    workspaceId: "ace",
    title: "Say hello",
    provider: "antigravity",
  });
  // The session opened: the root agent is there, starting, and nothing has run.
  app.daemon.apply(threadId, [
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      native: { provider: "antigravity", nativeId: "root" },
      cwd: "/Users/dev/acme",
    },
  ]);
  // Delivering the message failed on Git before it reached the agent: it is held.
  app.daemon.holdQueue(threadId, "not_sent", {
    code: "git_quarantined",
    title: "A stale Git lock blocks this checkout.",
  });
  app.daemon.command({
    id: CommandId.parse("first-hi"),
    deviceId: DeviceId.parse("phone"),
    payload: { type: "thread.send", threadId, input: [{ type: "text", text: "hi" }] },
  });
  const view = app.daemon.snapshot({ kind: "thread", threadId });
  expect(view && "thread" in view ? view.thread.status.state : undefined).toBe("failed");

  await app.open(`/t/${threadId}`);
  const main = await screen.findByRole("main");
  await within(main).findByText("Not sent");
  await act(async () => {});
  expect(within(main).queryByRole("group", { name: "Turn in progress" })).toBeNull();
  expect(within(main).queryByText(/^(Working|Starting)\b/)).toBeNull();
}, 30_000);
