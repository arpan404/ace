import { facts } from "@ace/fake-daemon";
import type { CommandPayload } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

/** A guest session: an agent on the Linux box using this machine's apps right now. */
function guestSession(app: ReturnType<typeof harness>) {
  app.daemon.createThread({
    id: "guest-session",
    workspaceId: "relay",
    provider: "claude",
    title: "Linux box · Fix the login flow",
    details: { guest: { host: "linux-box", name: "Linux box" } },
  });
  app.daemon.apply("guest-session", [
    facts.rootAgent("claude"),
    {
      type: "background.started",
      owner: "ace",
      agent: "root",
      task: "ace-guest:1",
      kind: "other",
      title: "screen_act from Linux box",
      stoppable: true,
    },
  ]);
  const sent: CommandPayload[] = [];
  const receive = app.daemon.command.bind(app.daemon);
  app.daemon.command = (command) => {
    sent.push(command.payload);
    return receive(command);
  };
  return sent;
}

test("a guest session shows whose work it is instead of a composer, and Stop ends it", async () => {
  const app = harness();
  const sent = guestSession(app);
  await app.open("/t/guest-session");
  const line = await screen.findByRole("group", { name: "Guest session" });
  expect(line.textContent).toContain("Used by agents on Linux box. Stop to end their work.");
  expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();

  await userEvent.click(within(line).getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(sent.filter((payload) => payload.type === "thread.interrupt")).toEqual([
      expect.objectContaining({ threadId: "guest-session", cascade: true }),
    ]),
  );
});

test("an ordinary thread keeps its composer", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "own-thread",
    workspaceId: "relay",
    provider: "claude",
    title: "Fix the login flow",
  });
  app.daemon.apply("own-thread", [facts.rootAgent("claude")]);
  await app.open("/t/own-thread");
  await screen.findByRole("combobox", { name: "Message" });
  expect(screen.queryByRole("group", { name: "Guest session" })).toBeNull();
});
