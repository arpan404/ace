import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { Command, type InteractionResolution, type ThreadId } from "@ace/protocol";
import { evalWorld, type EvalWorld } from "./evals/world.ts";
import { fakeHeadlessBackend } from "./browser-mcp-test-support.ts";

let running: EvalWorld | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

const Opened = z.object({ tabId: z.string() });
const Help = z.object({ status: z.string(), requestId: z.string(), tabId: z.string() });

async function browsing() {
  const world = await evalWorld({ browser: false, browserBackend: fakeHeadlessBackend() });
  running = world;
  const { agent, threadId } = await world.agent({});
  const opened = await agent.call("ace_browser_open", { url: "https://example.com/login" });
  expect(opened.failed).toBe(false);
  return { world, agent, threadId, tabId: Opened.parse(opened.data).tabId };
}

/** The open help request on `thread`, once the agent's call has reached ace. */
async function openRequest(current: EvalWorld, thread: ThreadId) {
  for (let attempt = 0; attempt < 400; attempt++) {
    await current.flush();
    const state = current.store.snapshotThread(thread);
    const open = Object.values(state?.interactions ?? {}).find(
      (each) => each.state === "pending" && each.request.kind === "browser_help",
    );
    if (open) return open;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("No help request opened");
}

function answer(
  current: EvalWorld,
  interactionId: string,
  deviceId: string,
  resolution: InteractionResolution,
) {
  const engine = current.daemon.engine;
  if (!engine) throw new Error("Missing engine");
  const command = Command.parse({
    id: `${deviceId}-${interactionId}`,
    deviceId,
    payload: { type: "interaction.resolve", interactionId, resolution },
  });
  return current.store.recordCommand(command.id, command.deviceId, () =>
    engine.handler.handle(command, current.store),
  );
}

it("a help request makes the thread need the person until they press Done, and the agent hears done", async () => {
  const { world, agent, threadId, tabId } = await browsing();
  const call = agent.call("ace_browser_request_help", {
    tabId,
    reason: "login",
    message: "Sign in with your work account",
  });
  const request = await openRequest(world, threadId);
  expect(request.request).toMatchObject({
    kind: "browser_help",
    tabId,
    reason: "login",
    url: "https://example.com/login",
  });
  expect(world.store.getThread(threadId)?.status.state).toBe("needs_you");

  // Agents can never answer it for the person.
  expect(
    answer(world, request.id, "ace-agent", { kind: "browser_help", outcome: "done" }),
  ).toMatchObject({ ok: false, error: "human_answer_required" });
  expect(
    answer(world, request.id, "person", { kind: "browser_help", outcome: "done" }),
  ).toMatchObject({ ok: true });
  const result = await call;
  expect(Help.parse(result.data)).toMatchObject({ status: "done", tabId });
  await world.endTurn(threadId);
  expect(world.store.getThread(threadId)?.status.state).not.toBe("needs_you");
});

it("a request for a tab the thread does not have is refused and nobody is asked", async () => {
  const { world, agent, threadId } = await browsing();
  const result = await agent.call("ace_browser_request_help", {
    tabId: "no-such-tab",
    reason: "captcha",
    message: "Solve the check",
  });
  expect(result).toMatchObject({ failed: true, data: { code: "tab_not_found" } });
  await world.flush();
  expect(world.store.getThread(threadId)?.status.state).not.toBe("needs_you");
});

it("an unanswered request stays open after the turn ends, and the person's Done arrives as their next message", async () => {
  const { world, agent, threadId, tabId } = await browsing();
  const result = await agent.call("ace_browser_request_help", {
    tabId,
    reason: "two_factor",
    message: "Enter the code from your phone",
    timeoutSeconds: 5,
  });
  expect(Help.parse(result.data)).toMatchObject({ status: "pending", tabId });
  await world.endTurn(threadId);
  // Correctness first: the thread never reads as done while the person still has to act.
  expect(world.store.getThread(threadId)?.status.state).toBe("needs_you");

  const request = await openRequest(world, threadId);
  expect(
    answer(world, request.id, "person", { kind: "browser_help", outcome: "done" }),
  ).toMatchObject({ ok: true });
  await world.flush();
  const items = world.store.readItemPage(threadId, world.store.headSeq() + 1, 50).items;
  expect(items).toContainEqual(
    expect.objectContaining({
      type: "message",
      role: "user",
      parts: [
        expect.objectContaining({
          text: expect.stringContaining("I did what you asked in the browser: Enter the code"),
        }),
      ],
    }),
  );
  expect(world.store.getThread(threadId)?.status.state).not.toBe("needs_you");
});

it("an agent that carries on in a new turn withdraws the request nobody answered", async () => {
  const { world, agent, threadId, tabId } = await browsing();
  const result = await agent.call("ace_browser_request_help", {
    tabId,
    reason: "dialog",
    message: "Choose whether to leave the page",
    timeoutSeconds: 5,
  });
  expect(Help.parse(result.data).status).toBe("pending");
  await world.endTurn(threadId);
  expect(world.store.getThread(threadId)?.status.state).toBe("needs_you");

  await world.startTurn(threadId);
  const state = world.store.snapshotThread(threadId);
  expect(
    Object.values(state?.interactions ?? {}).filter(
      (each) => each.request.kind === "browser_help" && each.state === "pending",
    ),
  ).toEqual([]);
  expect(world.store.getThread(threadId)?.status.state).not.toBe("needs_you");
});
