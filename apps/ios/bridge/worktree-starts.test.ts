import { native, until } from "./test-host.ts";
import { expect, test } from "vitest";
import {
  CommandId,
  WorktreeCreationProgress,
  type CommandPayload,
  type CommandResult,
  type ServerMessage,
} from "@ace/protocol";
import { PatchPump } from "./patches.ts";
import type { DismissedSends } from "./dismissed-sends.ts";
import { WorktreeStarts, type WorktreeOwner } from "./worktree-starts.ts";

/*
 * Back to New thread on a stopped worktree start asks the daemon to forget it first, and only
 * then sets its Unsent row aside, so every failure leaves something Back can finish later: a
 * daemon that already forgot the start (`not_found`) counts as having taken it. Nothing is sent
 * while another action is on its way. The daemon's socket and the phone's store are the edges
 * stood in for: each request waits for the test's answer, and saves succeed as the test says.
 */

const id = "start-command-back";
const stopped = WorktreeCreationProgress.parse({
  commandId: id,
  attempt: 1,
  state: "cancelled",
  step: "creating",
  startedAt: 1,
  elapsedMs: 10,
  steps: [{ step: "preparing", startedAt: 1, elapsedMs: 5 }],
  details: [],
  cleanupComplete: true,
  actions: ["retry", "local"],
});
const locked = WorktreeCreationProgress.parse({
  commandId: id,
  attempt: 1,
  state: "failed",
  step: "preparing",
  startedAt: 1,
  elapsedMs: 10,
  steps: [{ step: "preparing", startedAt: 1, elapsedMs: 5 }],
  details: [],
  cleanupComplete: true,
  error: "git_quarantined",
  message: "A stale Git lock from an earlier ace daemon fences /fake/ace.",
  actions: ["retry", "local"],
});

interface Asked {
  action: string;
  answer(ok: boolean, error?: string): void;
  lose(): void;
}
interface CommandAsked {
  payload: CommandPayload;
  answer(result: Partial<CommandResult> & { ok: boolean }): void;
  lose(error?: Error): void;
}

/**
 * `known`: whether the daemon still has the start when the phone first asks for it.
 * `progress`: whether the phone heard how it stopped before that (or the progress report itself).
 */
function fixture(
  known = true,
  progress: boolean | WorktreeCreationProgress = true,
  takenBack = false,
) {
  const pump = new PatchPump();
  native.ack = (accepted) => pump.ack(accepted);
  native.frames.length = 0;
  const asked: Asked[] = [];
  const commands: CommandAsked[] = [];
  const listeners: ((message: ServerMessage) => void)[] = [];
  const ready = { getSnapshot: () => "ready" as const, subscribe: () => () => {} };
  const owner: WorktreeOwner = {
    request: ((message: { action: string }) =>
      new Promise<unknown>((resolve, reject) =>
        asked.push({
          action: message.action,
          answer: (ok, error) =>
            resolve({ type: "worktree.creation.result", ok, ...(error ? { error } : {}) }),
          lose: () => reject(new Error("the reply was lost")),
        }),
      )) as WorktreeOwner["request"],
    command: ((payload: CommandPayload) =>
      new Promise<CommandResult>((resolve, reject) =>
        commands.push({
          payload,
          answer: (result) => resolve({ commandId: CommandId.parse("cmd-lock"), ...result }),
          lose: (error) => reject(error ?? new Error("the reply was lost")),
        }),
      )) as WorktreeOwner["command"],
    onMessage: (listener) => {
      listeners.push(listener);
      return () => {};
    },
    connectionState: () => ready as ReturnType<WorktreeOwner["connectionState"]>,
    connectionGeneration: () => ({ getSnapshot: () => 1, subscribe: () => () => {} }),
    pendingSends: () => ({ getSnapshot: () => [], subscribe: () => () => {} }),
  };
  const kept = new Set<string>(takenBack ? [id] : []);
  const saving = { works: true };
  const store: DismissedSends = {
    has: (commandId) => kept.has(commandId),
    dismiss: async (commandId) => {
      if (!saving.works) return false;
      kept.add(commandId);
      return true;
    },
    restore: async (commandId) => kept.delete(commandId),
    loaded: async () => {},
    observe: () => () => {},
  };
  const starts = new WorktreeStarts(owner, pump, (text, limit) => text.slice(0, limit), store);
  if (progress) {
    const report = progress === true ? stopped : progress;
    for (const listener of listeners)
      listener({ type: "worktree.creation.progress", ...report } as ServerMessage);
  }
  starts.follow(id, { message: "Fix the export", workspaceId: "ace" });
  // The `get` a followed start asks for: answered with nothing new, or the daemon forgot it.
  const get = asked.shift();
  if (known) get?.answer(true);
  else get?.answer(false, "not_found");
  /** Only the actions sent after the start was followed. */
  const actions = () => asked.map((request) => request.action);
  return { starts, asked, commands, actions, kept, saving };
}

const latest = (type: string, key?: string) =>
  native.frames.findLast((frame) => frame.type === type && (key === undefined || frame.id === key));
type Card = {
  card: {
    canReturn: boolean;
    message: string;
    workspaceId: string;
    locked: boolean;
    refused: string;
    sending: string;
    actions: unknown[];
  } | null;
  returned: boolean;
};
const card = () => latest("compose.worktree", id) as Card | undefined;
const receipt = (requestId: string) =>
  latest("receipt", requestId) as { ok: boolean; message: string } | undefined;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Back the daemon takes sets the Unsent row aside after it, and the card goes as taken back", async () => {
  const made = fixture();
  void made.starts.giveBack(id, "back-1");
  await settle();
  expect(made.actions()).toEqual(["dismiss"]);
  // Nothing local changes until the daemon has said yes.
  expect(made.kept.has(id)).toBe(false);
  made.asked[0]?.answer(true);
  expect(await until(() => receipt("back-1"))).toMatchObject({ ok: true });
  expect(card()).toMatchObject({ card: null, returned: true });
  expect(made.kept.has(id)).toBe(true);
});

test("Back while the daemon can't be reached changes nothing on the phone and says why", async () => {
  const made = fixture();
  void made.starts.giveBack(id, "back-2");
  await settle();
  made.asked[0]?.lose();
  expect(await until(() => receipt("back-2"))).toMatchObject({
    ok: false,
    message: "Couldn't reach the daemon. Try again once connected.",
  });
  expect(card()?.returned).toBe(false);
  expect(card()?.card?.canReturn).toBe(true);
  expect(made.kept.has(id)).toBe(false);
});

test("a Back the daemon took but whose reply was lost finishes on the next Back", async () => {
  const made = fixture();
  void made.starts.giveBack(id, "back-3a");
  await settle();
  // The daemon forgot the start; its yes never reached the phone.
  made.asked[0]?.lose();
  await until(() => receipt("back-3a"));
  expect(made.kept.has(id)).toBe(false);
  void made.starts.giveBack(id, "back-3b");
  await settle();
  made.asked[1]?.answer(false, "not_found");
  expect(await until(() => receipt("back-3b"))).toMatchObject({ ok: true });
  expect(card()).toMatchObject({ card: null, returned: true });
  expect(made.kept.has(id)).toBe(true);
});

test("a Back the daemon took but this phone couldn't save keeps the card and finishes next time", async () => {
  const made = fixture();
  made.saving.works = false;
  void made.starts.giveBack(id, "back-4a");
  await settle();
  made.asked[0]?.answer(true);
  expect(await until(() => receipt("back-4a"))).toMatchObject({
    ok: false,
    message: "Couldn't save that on this phone. Your message is still here.",
  });
  // The words stay on the card, for Back again.
  expect(card()?.card).toMatchObject({ canReturn: true, message: "Fix the export" });
  made.saving.works = true;
  await made.starts.giveBack(id, "back-4b");
  // The daemon already forgot it: only the phone's step is left.
  expect(made.actions()).toEqual(["dismiss"]);
  expect(await until(() => receipt("back-4b"))).toMatchObject({ ok: true });
  expect(made.kept.has(id)).toBe(true);
});

test("a stopped start the daemon forgot while away offers only Back, which needs no daemon", async () => {
  const made = fixture(false);
  const shown = await until(() => card()?.card ?? undefined);
  expect(shown).toMatchObject({ canReturn: true, actions: [], message: "Fix the export" });
  await made.starts.giveBack(id, "back-5");
  expect(made.actions()).toEqual([]);
  expect(await until(() => receipt("back-5"))).toMatchObject({ ok: true });
  expect(made.kept.has(id)).toBe(true);
});

test("Back while Retry is still on its way sends nothing and keeps the start", async () => {
  const made = fixture();
  made.starts.act(id, "retry");
  await settle();
  // Retry's reply is held: Back arrives before the card could say Retry is running.
  await made.starts.giveBack(id, "back-6");
  expect(made.actions()).toEqual(["retry"]);
  expect(await until(() => receipt("back-6"))).toMatchObject({
    ok: false,
    message: "Another action on this worktree is still running. Try again in a moment.",
  });
  expect(card()?.returned).toBe(false);
  expect(made.kept.has(id)).toBe(false);
  made.asked[0]?.answer(true);
});

test("a start just sent that the daemon hasn't made yet shows no card and can't be given back", async () => {
  const made = fixture(false, false);
  await settle();
  expect(card()?.card ?? null).toBeNull();
  await made.starts.giveBack(id, "back-7");
  expect(await until(() => receipt("back-7"))).toMatchObject({ ok: false });
  expect(made.actions()).toEqual([]);
  expect(made.kept.has(id)).toBe(false);
});

test("a start already taken back stays gone after a relaunch: no card, nothing to give back", async () => {
  const made = fixture(false, true, true);
  await settle();
  expect(card()?.card ?? null).toBeNull();
  await made.starts.giveBack(id, "back-8");
  expect(await until(() => receipt("back-8"))).toMatchObject({ ok: false });
  expect(made.actions()).toEqual([]);
});

test("clearing a stale Git lock clears the project's lock then retries the start", async () => {
  const made = fixture(true, locked);
  expect(await until(() => card()?.card ?? undefined)).toMatchObject({
    locked: true,
    workspaceId: "ace",
    message: "Fix the export",
  });
  void made.starts.clearLock(id, "lock-1");
  await until(() => made.commands.length === 1);
  expect(made.commands.map((item) => item.payload)).toEqual([
    { type: "workspace.git.lock.clear", workspaceId: "ace" },
  ]);
  expect(
    await until(() => (card()?.card?.sending === "clearLock" ? card()?.card : undefined)),
  ).toMatchObject({ sending: "clearLock", canReturn: false });
  // Competing Back while the clear is in flight is refused as busy.
  await made.starts.giveBack(id, "back-during-clear");
  expect(await until(() => receipt("back-during-clear"))).toMatchObject({
    ok: false,
    message: "Another action on this worktree is still running. Try again in a moment.",
  });
  expect(made.actions()).toEqual([]);
  made.commands[0]?.answer({ ok: true, locksCleared: 1 });
  await until(() => made.actions().length === 1);
  expect(made.actions()).toEqual(["retry"]);
  made.asked[0]?.answer(true);
  expect(await until(() => receipt("lock-1"))).toMatchObject({
    ok: true,
    message: "Lock cleared. Retry to start the thread.",
  });
});

test("when the stale Git lock is still held, the card says why in ui-core wording and does not retry", async () => {
  const made = fixture(true, locked);
  await until(() => card()?.card?.locked === true);
  void made.starts.clearLock(id, "lock-2");
  await until(() => made.commands.length === 1);
  made.commands[0]?.answer({
    ok: false,
    error: "git_quarantined",
    detail: "Another ace daemon (pid 42) still holds it.",
  });
  expect(await until(() => receipt("lock-2"))).toMatchObject({
    ok: false,
    message: "The lock is still held. Another ace daemon (pid 42) still holds it.",
  });
  expect(made.actions()).toEqual([]);
  expect(await until(() => (card()?.card?.refused ? card()?.card : undefined))).toMatchObject({
    locked: true,
    sending: "",
    canReturn: true,
    refused: "The lock is still held. Another ace daemon (pid 42) still holds it.",
    message: "Fix the export",
    workspaceId: "ace",
  });
});

test("after a stale Git lock stops a worktree start, clearing the lock retries and starts the same thread", async () => {
  const { ClientCore } = await import("@ace/client");
  const { FakeDaemon, fakeTransport } = await import("@ace/fake-daemon");
  const { DeviceId, HostId } = await import("@ace/protocol");
  const { ComposeActions } = await import("./compose-actions.ts");
  const pump = new PatchPump();
  native.ack = (accepted) => pump.ack(accepted);
  native.frames.length = 0;
  const daemon = new FakeDaemon({
    clock: Date.now,
    hostId: "ios-lock-host",
    token: "ios-lock-token",
  });
  daemon.createThread({
    id: "seed-1",
    workspaceId: "ace",
    title: "Seed",
    provider: "codex",
  });
  daemon.workspace.git.paceCreation("ace", 1);
  daemon.workspace.git.lock("ace", "/fake/ace");
  const client = new ClientCore({
    deviceId: DeviceId.parse("ios-lock-test"),
    expectedHostId: HostId.parse("ios-lock-host"),
    transport: () => fakeTransport(daemon),
    credential: async () => ({ token: "ios-lock-token" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  const sidebar = client.threads();
  let compose: InstanceType<typeof ComposeActions> | undefined;
  try {
    void client.start();
    await until(() => client.state === "ready");
    compose = new ComposeActions(client, pump, (text, limit) => text.slice(0, limit), Date.now);
    compose.compose({ kind: "agents" });
    const agents = (await until(
      () => latest("compose.agents")?.state === "ready" && latest("compose.agents"),
    )) as { start: { provider: string; model: string } | null };
    compose.compose({
      kind: "create",
      commandId: "draft-lock-0001",
      workspaceId: "ace",
      provider: agents.start?.provider,
      model: agents.start?.model,
      mode: "worktree",
      text: "Fix the export",
    });
    const blocked = (await until(() => {
      const shown = latest("compose.worktree", "draft-lock-0001")?.card as Card["card"] | undefined;
      return shown?.locked ? shown : undefined;
    })) as NonNullable<Card["card"]>;
    expect(blocked).toMatchObject({
      locked: true,
      workspaceId: "ace",
      message: "Fix the export",
    });

    compose.compose({
      kind: "worktreeClearLock",
      commandId: "draft-lock-0001",
      requestId: "clear-lock-0001",
    });
    expect(await until(() => receipt("clear-lock-0001"))).toMatchObject({
      ok: true,
      message: "Lock cleared. Retry to start the thread.",
    });
    const made = await until(() => latest("compose.worktree", "draft-lock-0001")?.made);
    expect(typeof made).toBe("string");
    expect(latest("compose.worktree", "draft-lock-0001")?.card).toBeNull();
    const threads = daemon.snapshot({ kind: "threads" });
    const started = threads?.kind === "threads" ? threads.threads[String(made)] : undefined;
    expect(started).toMatchObject({ workspaceId: "ace", title: "Fix the export" });
  } finally {
    compose?.close();
    sidebar.release();
    await client.close();
  }
});
