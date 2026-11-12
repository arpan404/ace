import { expect, test } from "vitest";
import {
  ThreadId,
  WorkspaceId,
  type Command,
  type CommandPayload,
  type SpadeBrainFrame,
} from "@ace/protocol";
import { SpadeBrains, type SpadeBrainsDeps } from "./brain-sessions.ts";

const botThread = ThreadId.parse("6711171d-5874-4f4e-90ef-5fcc410e487a");

/** A daemon whose bot `b1` already has a Codex session on the `work` account. */
function daemon(defaultAccount: string) {
  const sent: CommandPayload[] = [];
  const thread = {
    id: botThread,
    provider: "codex",
    execution: { provider: "codex", instanceId: "work", model: "m", options: {} },
  };
  const store = {
    statement: () => ({ get: () => ({ id: botThread }) }),
    getThread: (id: ThreadId) => (id === botThread ? thread : undefined),
    subscribe: () => () => {},
    recordCommand: (_id: unknown, _device: unknown, run: () => unknown) => run(),
    appendEvents: () => [],
    readEvents: () => [],
    getInteraction: () => undefined,
  } as unknown as SpadeBrainsDeps["store"];
  const brains = new SpadeBrains({
    store,
    engine: () => ({
      targetInstance: () => defaultAccount,
      discardRecovery: () => {},
      liveWork: () => ({ agentsRunning: 0, operationsRunning: 0 }),
      internalHandler: {
        handle(command: Command) {
          sent.push(command.payload);
          return { commandId: command.id, ok: false, error: "account_unavailable" };
        },
      },
    }),
    project: () => ({ workspaceId: WorkspaceId.parse("01a1ceeb-4bd0-749c-bcfa-4a8c428ddd74") }),
    roster: () => undefined,
    clock: { now: () => 0, after: () => () => {} },
    id: () => crypto.randomUUID(),
  });
  return { brains, sent };
}

async function turn(brains: SpadeBrains, account?: string) {
  const frames: SpadeBrainFrame[] = [];
  await brains.turn(
    {
      bot: "b1",
      provider: "codex",
      ...(account ? { account } : {}),
      model: "m",
      instructions: "Rules",
      instructionsChanged: false,
      message: "Hi",
    },
    new AbortController().signal,
    (frame) => frames.push(frame),
  );
  return frames;
}

test("a turn with no account runs on ace's default account, never on the session's old one", async () => {
  const moved = daemon("home");
  await turn(moved.brains);
  expect(moved.sent).toEqual([
    expect.objectContaining({ type: "thread.create", provider: "codex", accountId: "home" }),
  ]);
  // The default is the session's own account: it carries on in the same session.
  const same = daemon("work");
  await turn(same.brains);
  expect(same.sent).toEqual([
    expect.objectContaining({ type: "thread.send", threadId: botThread }),
  ]);
  // A named account other than the session's starts a new one.
  const named = daemon("work");
  await turn(named.brains, "home");
  expect(named.sent).toEqual([
    expect.objectContaining({ type: "thread.create", accountId: "home" }),
  ]);
});
