import { native } from "./test-host.ts";
import { ClientCore, type Lease, type ReadSnapshotStorage, type ThreadSource } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { PatchPump, followThread } from "./patches.ts";
import { ThreadSession } from "./thread-session.ts";
import type { ChunkReader } from "./thread-attachments.ts";
import type { SendOps } from "./send-ops.ts";

/*
 * The thread screen's bridge over the real SDK and an in-process fake daemon, for behaviour
 * tests: the production pump, item follower and thread session, with `test-host.ts` standing in
 * for Swift. No provider CLI runs. Test-only.
 */

export { native };
export const pump = new PatchPump();
native.ack = (accepted) => pump.ack(accepted);
/** Every text frame the client sent the daemon. */
export const sent: string[] = [];
/** A send the daemon turns down once (its retry goes through), by its text. */
export const refuseOnce = { text: "Refuse this once" };
/** How long the daemon takes to receive a `settings.get` (a slow link), in milliseconds. */
export const slowSettings = { ms: 0 };
/** `thread.fork` commands the daemon refuses, or holds back until `release` (a slow link). */
export const forks = { refuse: false, hold: false, release: () => {} };
/** `queue.remove` commands the daemon refuses as if another device moved the queue first. */
export const queueRefusals = { remove: false, edit: false };
/** One account's `models.list`: answered `slowMs` late, or failed `fails` times first. */
export const accountModels = { instance: "", slowMs: 0, fails: 0 };

let client: ClientCore | undefined;
let lease: Lease<ThreadSource> | undefined;
let stop: (() => void) | undefined;
let session: ThreadSession | undefined;

export async function reset(): Promise<void> {
  session?.dispose();
  stop?.();
  lease?.release();
  await client?.close();
  native.frames.length = 0;
  slowSettings.ms = 0;
  refuseOnce.text = "Refuse this once";
  Object.assign(forks, { refuse: false, hold: false, release: () => {} });
  Object.assign(accountModels, { instance: "", slowMs: 0, fails: 0 });
  Object.assign(queueRefusals, { remove: false, edit: false });
  native.calls.clear();
  sent.length = 0;
}

function refusal(text: string): string | undefined {
  const message = JSON.parse(text) as {
    type?: string;
    requestId?: string;
    options?: { instance?: string };
    command?: { id?: string; payload?: { type?: string; input?: { text?: string }[] } };
  };
  if (
    message.type === "models.list" &&
    accountModels.fails > 0 &&
    message.options?.instance === accountModels.instance
  ) {
    accountModels.fails -= 1;
    return JSON.stringify({
      type: "error",
      requestId: message.requestId,
      code: "unavailable",
      message: "unavailable",
    });
  }
  const command = message.type === "command" ? message.command : undefined;
  if (
    (command?.payload?.type === "queue.remove" && queueRefusals.remove) ||
    (command?.payload?.type === "queue.edit" && queueRefusals.edit)
  )
    return JSON.stringify({
      type: "commandResult",
      commandId: command.id,
      ok: false,
      error: "queue_conflict",
    });
  if (command?.payload?.type === "thread.fork" && forks.refuse)
    return JSON.stringify({
      type: "commandResult",
      commandId: command.id,
      ok: false,
      error: "fork_point_not_found",
    });
  if (command?.payload?.type !== "thread.send" || command.id?.endsWith(":retry")) return undefined;
  if (command.payload.input?.[0]?.text !== refuseOnce.text) return undefined;
  return JSON.stringify({
    type: "commandResult",
    commandId: command.id,
    ok: false,
    error: "refused",
  });
}

export function fixture(): FakeDaemon {
  return new FakeDaemon({ clock: Date.now, hostId: "ios-test-host", token: "ios-test-token" });
}

/**
 * `items`: the SDK's window. `readSnapshots`: what an earlier launch kept, painted before the
 * daemon's snapshot. `held`: nothing the daemon sends arrives until it settles, as on a slow
 * network.
 */
export function connect(
  daemon: FakeDaemon,
  {
    items,
    readSnapshots,
    held,
  }: {
    items?: number;
    readSnapshots?: ReadSnapshotStorage;
    held?: Promise<void>;
  } = {},
): ClientCore {
  let saved: string | null = null;
  client = new ClientCore({
    ...(readSnapshots ? { readSnapshots } : {}),
    deviceId: DeviceId.parse("ios-bridge-test"),
    expectedHostId: HostId.parse("ios-test-host"),
    ...(items ? { limits: { items } } : {}),
    transport: () => {
      const inner = fakeTransport(daemon);
      let deliver: ((text: string) => void) | undefined;
      return {
        open: (events) => {
          let arriving = held ?? Promise.resolve();
          const later =
            <A extends unknown[]>(run: (...args: A) => void) =>
            (...args: A) => {
              if (!held) return run(...args);
              arriving = arriving.then(() => run(...args));
            };
          const gated = { ...events, open: later(events.open), message: later(events.message) };
          deliver = (text) => gated.message(text);
          inner.open(gated);
        },
        send: (text) => {
          sent.push(text);
          const refused = refusal(text);
          if (refused) queueMicrotask(() => deliver?.(refused));
          else if (slowSettings.ms && text.includes('"type":"settings.get"'))
            setTimeout(() => inner.send(text), slowSettings.ms);
          else if (forks.hold && text.includes('"type":"thread.fork"'))
            forks.release = () => inner.send(text);
          else if (
            accountModels.slowMs &&
            text.includes('"type":"models.list"') &&
            text.includes(`"instance":"${accountModels.instance}"`)
          )
            setTimeout(() => inner.send(text), accountModels.slowMs);
          else inner.send(text);
        },
        close: () => inner.close(),
      };
    },
    credential: async () => ({ token: "ios-test-token" }),
    storage: {
      load: async () => saved,
      save: async (value) => {
        saved = value;
      },
    },
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
  void client.start();
  return client;
}

export function open(
  owner: ClientCore,
  threadId: string,
  chunks?: ChunkReader,
  ops?: SendOps,
): ThreadSession {
  lease = owner.thread(threadId);
  stop = followThread(lease.store, threadId, 1, pump);
  session = new ThreadSession(owner, lease.store, threadId, 1, pump, chunks, undefined, ops);
  return session;
}

/** The latest delivered patch of a type (and id), as Swift would hold it. */
export function latest(type: string, id?: string): Record<string, unknown> | undefined {
  for (let index = native.frames.length - 1; index >= 0; index--) {
    const frame = native.frames[index];
    if (frame?.type === type && (id === undefined || frame.id === id)) return frame;
  }
  return undefined;
}
/** The rows Swift holds for an id-keyed patch type, after deletions. */
export function rows(type: string): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const frame of native.frames)
    if (frame.type === type && typeof frame.id === "string") {
      if (frame.row) byId.set(frame.id, frame.row as Record<string, unknown>);
      else byId.delete(frame.id);
    }
  return [...byId.values()];
}
export async function until<T>(read: () => T | undefined | false, label: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
/** Command payloads of a type the client sent, in order. */
export function commands(type: string): Record<string, unknown>[] {
  return sent.flatMap((text) => {
    const message = JSON.parse(text) as {
      type?: string;
      command?: { payload?: { type?: string } };
    };
    return message.type === "command" && message.command?.payload?.type === type
      ? [message.command.payload as Record<string, unknown>]
      : [];
  });
}
