import { expect } from "vitest";
import { Automation, Command, type CommandPayload, type ThreadId } from "@ace/protocol";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { connectAutomations } from "./automation-socket-test-support.ts";
import { commandContext } from "./commands.ts";
import { end } from "./engine/test-support.ts";

const definition = (workspace: string) =>
  Automation.parse({
    id: "one-thread-job",
    title: "One thread job",
    enabled: true,
    workspace,
    provider: "claude",
    prompt: "Check the build",
    worktree: false,
    trigger: { kind: "manual" },
    missedRun: "skip",
    concurrency: 1,
    jitterMs: 0,
  });

export type Fixture = Awaited<ReturnType<typeof daemonFixture>>;
/** Real daemon work under a loaded machine can take a few seconds. */
export const wait = { timeout: 15_000 };

/**
 * The agent answers its turn with `text`, as its own new message, once the provider has taken
 * that turn's input (its `turn`th), so the turn's start never lands after its end.
 */
export async function answer(
  f: Fixture,
  thread: ThreadId,
  turn: number,
  item: string,
  text: string,
) {
  await expect.poll(() => f.h.inputs.get(thread)?.length ?? 0, wait).toBeGreaterThanOrEqual(turn);
  await f.h.emit(
    thread,
    {
      type: "item.upsert",
      agent: "root",
      item,
      draft: {
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text }],
        complete: true,
      },
    },
    end,
  );
  await settle(f);
}

/** Let the daemon act on what just happened: flush its engine and move its clock on. */
export async function settle(f: Fixture) {
  await f.daemon.engine?.flush();
  f.h.clock.advance(f.h.clock.now() + 1000);
  await f.daemon.engine?.flush();
}

export async function setUp() {
  const f = await daemonFixture();
  const app = await connectAutomations(f, "one-thread");
  await f.daemon.settings.set("automations.enabled", true, { kind: "global" });
  const automation = definition(f.workspace);
  expect(
    await app.ask({
      type: "automation.put",
      requestId: "create",
      automation,
      expectedRevision: null,
    }),
  ).toMatchObject({ ok: true });
  const run = (requestId: string) =>
    app.ask({ type: "automation.run", requestId, id: automation.id, variables: {} });
  const runs = async () =>
    (
      await app.ask({
        type: "automation.inbox",
        requestId: "history",
        automationId: automation.id,
        limit: 50,
      })
    ).inbox?.runs ?? [];
  const threads = () =>
    f.daemon.store.listThreads().filter((thread) => thread.title === "Automation: One thread job");
  return { f, app, automation, run, runs, threads };
}

/** The person sends `text` into the thread themselves, as from the composer. */
export function personSend(f: Fixture, thread: ThreadId, id: string, text: string) {
  return personCommand(f, id, {
    type: "thread.send",
    threadId: thread,
    input: [{ type: "text", text }],
  });
}

/** A command from the person's own device, such as a Stop or a queue edit. */
export function personCommand(f: Fixture, id: string, payload: CommandPayload) {
  const command = Command.parse({ id, deviceId: "person", payload });
  return f.daemon.engine?.handler.handle(command, commandContext(f.daemon.store));
}
