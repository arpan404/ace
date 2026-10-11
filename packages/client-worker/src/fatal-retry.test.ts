import { ScenarioPlayer, longHistory } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { cleanups, world } from "./worker-test-support.ts";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

test("retry replaces a fatal shared client while another window remains attached", async () => {
  const { daemon, tab, faults, sockets, advance } = world();
  new ScenarioPlayer(daemon, longHistory(2)).runUntilBlocked();
  const first = tab();
  const second = tab();
  await Promise.all([first.start(), second.start()]);
  await vi.waitFor(() => expect(first.state).toBe("ready"));
  faults.incoming = (_message, _text, deliver) => deliver("invalid JSON");
  void first
    .command({
      type: "thread.rename",
      threadId: ThreadId.parse("thread-router"),
      title: "Fatal trigger",
    })
    .catch(() => {});
  await vi.waitFor(() => expect(first.state).toBe("fatal"));
  faults.incoming = (_message, text, deliver) => deliver(text);
  await first.close();
  await first.left;
  const retry = tab();
  await retry.start();
  await vi.waitFor(() => expect(retry.state).toBe("ready"));
  expect(sockets.opened).toBe(2);
  await second.close();
  await second.left;
  advance(30);
  const result = await retry.command({
    type: "thread.rename",
    threadId: ThreadId.parse("thread-router"),
    title: "Recovered",
  });
  expect(result.ok).toBe(true);
  const same = tab();
  await same.start();
  await vi.waitFor(() => expect(same.state).toBe("ready"));
  expect(sockets.opened).toBe(2);
});
