import { afterEach, expect, it } from "vitest";
import { Command } from "@ace/protocol";
import {
  Help,
  answer,
  browsing,
  closeBrowsing,
  openRequest,
  pendingHelp,
  withdrawn,
} from "./browser-help-test-support.ts";

/*
 * When a browser-help request stops being the person's: its thread is archived, its tab closes,
 * or it closed some other way. Another agent's new turn leaves it alone.
 */

afterEach(closeBrowsing);

it("archiving the thread withdraws its browser help, so it never sits waiting on the person", async () => {
  const { world, threadId, first } = await pendingHelp();
  expect(first.status).toBe("pending");
  const engine = world.daemon.engine;
  if (!engine) throw new Error("Missing engine");
  const command = Command.parse({
    id: "archive-1",
    deviceId: "person",
    payload: { type: "thread.archive", threadId },
  });
  expect(
    world.store.recordCommand(command.id, command.deviceId, () =>
      engine.handler.handle(command, world.store),
    ),
  ).toMatchObject({ ok: true });
  await withdrawn(world, threadId);
});

it("closing the tab the agent asked about withdraws its browser help", async () => {
  const { world, agent, threadId, tabId, first } = await pendingHelp();
  expect(first.status).toBe("pending");
  const closed = await agent.call("browser_tabs", { action: "close", tabId });
  expect(closed.failed).toBe(false);
  // Anything that happens in the thread next looks again at what its requests wait on.
  world.linkPr(threadId, 7);
  await withdrawn(world, threadId);
});

it("a subagent's new turn leaves the main agent's browser help open", async () => {
  const { world, threadId, first } = await pendingHelp();
  await world.subagentTurn(threadId, "worker");
  await world.flush();
  const request = await openRequest(world, threadId);
  expect(request.id).toBe(first.requestId);
});

it("Done on a request that already closed is refused and never reaches the agent", async () => {
  const { world, agent, threadId, tabId } = await browsing();
  await world.startTurn(threadId);
  const result = await agent.call("browser_request_help", {
    tabId,
    reason: "login",
    message: "Sign in",
    timeoutSeconds: 5,
  });
  const { requestId } = Help.parse(result.data);
  // Interrupting closes it, as a restart expires it, while its record could linger.
  await world.interruptTurn(threadId);
  await world.flush();
  expect(
    answer(world, requestId, "person", { kind: "browser_help", outcome: "done" }),
  ).toMatchObject({ ok: false });
  await world.flush();
  const items = world.store.readItemPage(threadId, world.store.headSeq() + 1, 50).items;
  expect(JSON.stringify(items)).not.toContain("I did what you asked in the browser");
});
