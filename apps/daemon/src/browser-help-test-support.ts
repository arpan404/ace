import { expect } from "vitest";
import { z } from "zod";
import { Command, type InteractionResolution, type ThreadId } from "@ace/protocol";
import { evalWorld, type EvalWorld } from "./evals/world.ts";
import { fakeHeadlessBackend } from "./browser-mcp-test-support.ts";

/*
 * The browser-help process tests' shared world: a thread whose agent has a tab open, the help
 * request it opens, and the person's answer through the engine as a device sends it.
 */

let running: EvalWorld | undefined;
/** Closes the world the last test opened (each file's afterEach). */
export async function closeBrowsing(): Promise<void> {
  await running?.close();
  running = undefined;
}

const Opened = z.object({ tabId: z.string() });
export const Help = z.object({ status: z.string(), requestId: z.string(), tabId: z.string() });

export async function browsing() {
  const world = await evalWorld({ browser: false, browserBackend: fakeHeadlessBackend() });
  running = world;
  const { agent, threadId } = await world.agent({});
  const opened = await agent.call("browser_open", { url: "https://example.com/login" });
  expect(opened.failed).toBe(false);
  return { world, agent, threadId, tabId: Opened.parse(opened.data).tabId };
}

/** The open help request on `thread`, once the agent's call has reached ace. */
export async function openRequest(current: EvalWorld, thread: ThreadId) {
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

export function answer(
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

/** The request is no longer the person's: the thread doesn't wait on it. */
export async function withdrawn(world: EvalWorld, threadId: ThreadId) {
  await world.flush();
  const open = Object.values(world.store.snapshotThread(threadId)?.interactions ?? {}).filter(
    (each) => each.state === "pending" && each.request.kind === "browser_help",
  );
  expect(open).toEqual([]);
  expect(world.store.getThread(threadId)?.status.state).not.toBe("needs_you");
}

export async function pendingHelp(timeoutSeconds = 5) {
  const opened = await browsing();
  const result = await opened.agent.call("browser_request_help", {
    tabId: opened.tabId,
    reason: "login",
    message: "Sign in",
    timeoutSeconds,
  });
  return { ...opened, first: Help.parse(result.data) };
}
