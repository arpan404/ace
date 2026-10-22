import type { ExecutionResult } from "@ace/automations";
import { isAgentProse } from "@ace/projection";
import { Command, type CommandId, type DeviceId, type Item, type ThreadId } from "@ace/protocol";
import { commandContext } from "./commands.ts";
import type { ServiceContext } from "./services/types.ts";
import { readThreadTree } from "./thread-tree.ts";
import { treeOutcome } from "./work-outcome.ts";
import { systemClock } from "./engine/actor.ts";

const resultLimit = 8192;
/** How many of the thread's newest items are read for a run's answer. */
const tailItems = 60;

/** The transcript item a sent or created input becomes once the thread takes it from its queue. */
export const inputItemId = (commandId: string) => `input:${commandId}`;

/**
 * What a run answered: the root agent's last prose after the run's own input, joined and capped.
 * When the input has scrolled out of the newest items, the root agent's last prose stands in.
 */
export function runAnswer(
  items: readonly Item[],
  inputId: string,
  rootAgentId: string | undefined,
) {
  const start = items.findIndex((item) => item.id === inputId);
  const after = start === -1 ? items : items.slice(start + 1);
  for (const item of after.toReversed()) {
    if (!isAgentProse(item) || item.synthetic) continue;
    if (rootAgentId && item.agentId !== rootAgentId) continue;
    const text = item.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim();
    if (text) return text.slice(0, resultLimit);
  }
  return undefined;
}

/** Whether the thread did anything after the run's input: an item of the agent's own. */
function workedSince(items: readonly Item[], inputId: string): boolean {
  const start = items.findIndex((item) => item.id === inputId);
  return start !== -1 && start < items.length - 1;
}

/**
 * Follow one run in an automation's thread until it settles. The run starts once its input
 * leaves the thread's queue, and it settles only after the thread has worked since then and its
 * whole tree is done or failed, so the previous run's "done" never closes this one. Anything
 * waiting on a person keeps it running. `recovered` trusts a send made before a restart. A run
 * whose message `stop` took out of the queue settles as stopped, even across a restart.
 */
export function followRun(
  context: ServiceContext,
  threadId: ThreadId,
  commandId: string,
  signal: AbortSignal,
  options: { recovered?: boolean; stop?: { id: CommandId; deviceId: DeviceId } } = {},
): Promise<ExecutionResult> {
  const recovered = options.recovered ?? false;
  const { store } = context;
  const inputId = inputItemId(commandId);
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    let stop = noop;
    let cancelTimer = noop;
    let settled = false;
    let members = new Set<ThreadId>([threadId]);
    let delivered = false;
    let sawWork = recovered;
    const finish = (result: ExecutionResult) => {
      settled = true;
      cancelTimer();
      stop();
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => {
      settled = true;
      cancelTimer();
      stop();
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const tail = () =>
      store.readBoundedItemPage(threadId, store.headSeq() + 1, tailItems, 256 * 1024).items;
    const inspect = () => {
      if (settled) return;
      const thread = store.getThread(threadId);
      if (!thread || thread.deletedAt !== undefined) {
        finish({
          threadId,
          status: "failed",
          result: "Its thread was deleted before the run finished.",
        });
        return;
      }
      delivered ||= store.itemCreatedSeq(threadId, inputId) !== undefined;
      const stopped =
        options.stop !== undefined &&
        store.commandReceipt(options.stop.id, options.stop.deviceId)?.ok === true;
      if (!delivered) {
        if (stopped) finish({ threadId, status: "failed", result: "Stopped before it started." });
        return;
      }
      // Our own stop leaves the thread marked stopped, waiting on the person; the run is over.
      if (stopped && thread.status.state !== "working") {
        finish({ threadId, status: "failed", result: "Stopped before it finished." });
        return;
      }
      const facts = readThreadTree(context, threadId);
      if (facts) members = new Set(facts.map((member) => member.threadId));
      const outcome = facts && treeOutcome(facts);
      if (outcome !== "ok" && outcome !== "failed") {
        sawWork = true;
        return;
      }
      const items = tail();
      if (!sawWork && !workedSince(items, inputId)) return;
      const answer = runAnswer(items, inputId, thread.rootAgentId);
      finish({
        threadId,
        status: outcome === "ok" ? "succeeded" : "failed",
        result:
          answer ??
          (outcome === "ok" ? "Finished without a written answer." : "Stopped before it finished."),
      });
    };
    stop = store.subscribe((events) => {
      if (
        events.some(
          (event) =>
            members.has(event.threadId) &&
            (event.payload.type === "thread.updated" ||
              event.payload.type === "thread.client.updated" ||
              event.payload.type === "queue.updated"),
        )
      )
        inspect();
    });
    signal.addEventListener("abort", abort, { once: true });
    const clock = context.options.engine?.clock ?? systemClock;
    const refresh = () => {
      inspect();
      if (!settled) cancelTimer = clock.setTimer(refresh, 500);
    };
    refresh();
  });
}

function noop(): void {}

/**
 * Stop one run in its thread, for a paused or deleted automation, without touching anyone
 * else's work: a message still waiting in the queue is taken out; a turn is stopped only while
 * it is this run's own, the run's input being the thread's newest message from outside it.
 */
export async function stopRun(
  context: ServiceContext,
  threadId: ThreadId,
  commandId: CommandId,
  stopId: CommandId,
  deviceId: DeviceId,
): Promise<void> {
  const { store, services } = context;
  const thread = store.getThread(threadId);
  if (!thread || thread.deletedAt !== undefined) return;
  const handle = services.engine?.internalHandler ?? services.handler;
  if (!handle) throw new Error("engine_unavailable");
  const queue = services.engine?.queue(threadId);
  const waiting = queue?.messages.some((message) => message.id === commandId);
  const inputId = inputItemId(commandId);
  const items = store.readBoundedItemPage(
    threadId,
    store.headSeq() + 1,
    tailItems,
    256 * 1024,
  ).items;
  const ownTurn = isOwnTurn(items, inputId, (id) => store.itemCreatedSeq(threadId, id));
  const payload =
    waiting && queue
      ? {
          type: "queue.remove" as const,
          threadId,
          expectedRevision: queue.revision,
          messageId: commandId,
        }
      : ownTurn
        ? { type: "thread.interrupt" as const, threadId, cascade: true }
        : undefined;
  if (!payload) return;
  const command = Command.parse({ id: stopId, deviceId, payload });
  await store.write(() =>
    store.recordCommand(command.id, command.deviceId, () =>
      handle.handle(command, commandContext(store)),
    ),
  );
}

/**
 * Whether the thread's current turn is the run's own: no message from outside the agent came
 * after its input. An input not written yet is a turn just starting, so it is the run's.
 */
export function isOwnTurn(
  items: readonly Item[],
  inputId: string,
  writtenAt: (itemId: string) => number | undefined,
): boolean {
  const own = writtenAt(inputId);
  if (own === undefined) return true;
  const newest = items.findLast(
    (item) => item.type === "message" && item.role === "user" && !item.synthetic,
  );
  if (!newest || newest.id === inputId) return true;
  const newestAt = writtenAt(newest.id);
  return newestAt === undefined || newestAt <= own;
}
