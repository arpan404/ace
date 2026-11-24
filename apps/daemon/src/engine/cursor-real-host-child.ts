// A daemon process whose Cursor threads open the real host (cursor-real-host-support.ts), killed
// by its parent at an exact commit point: as soon as the outermost transaction that committed a
// frame of the kind named by the argument returns, it writes the signal file and freezes its
// thread, so nothing after that commit runs.
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProcessInventory } from "@ace/provider-kit/process-inventory";
import { ThreadId } from "@ace/protocol";
import { observeProcessGroups } from "@ace/provider-kit/process-owner";
import { Store } from "../store.ts";
import { Engine } from "./index.ts";
import { AdapterRegistry } from "./registry.ts";
import { realHostAdapter } from "./cursor-real-host-support.ts";

const [database, entry, home, sends, killAfter, signal] = process.argv.slice(2);
if (!database || !entry || !home || !sends || !killAfter || !signal)
  throw new Error("Missing arguments");
const store = new Store(database);
// As the daemon does: every process group it starts is on record for the next start.
observeProcessGroups(new ProcessInventory(join(dirname(database), "processes.sqlite")));
const committed = () =>
  store
    .statement(
      "SELECT 1 FROM engine_provider_frames WHERE json_extract(frame,'$.data.kind')=? LIMIT 1",
    )
    .get(killAfter) !== undefined;
const atomic = store.atomic.bind(store);
let depth = 0;
store.atomic = ((run: Parameters<typeof atomic>[0]) => {
  depth++;
  try {
    return atomic(run);
  } finally {
    depth--;
    if (depth === 0 && committed()) {
      writeFileSync(signal, killAfter);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  }
}) as typeof store.atomic;
const registry = new AdapterRegistry();
registry.register(realHostAdapter(entry, home, sends), {
  installed: true,
  auth: "logged_in",
  loginHint: "offline",
});
// Boot one ran no host: nothing of it can still be running.
const engine = new Engine(store, {
  registry,
  selectInstance: () => "account-a",
  cursorPreviousProcessesGone: async () => true,
});
void engine.flush();
// Unlike Node's, a forked Bun process is not held open by its IPC channel, and unlike boot one
// this daemon has no message listener. So when its restart pass leaves the engine nothing to do,
// the loop drains and it exits 0 before its kill point: the parent can only report that. Say what
// was left instead, so that failure names its cause (which thread state, which queue).
process.on("beforeExit", () => {
  if (existsSync(signal)) return;
  const threadId = ThreadId.parse("crashed-thread");
  try {
    const thread = store.getThread(threadId);
    const queue = engine.queue(threadId);
    const frames = Number(
      store
        .statement("SELECT COUNT(*) AS n FROM engine_provider_frames WHERE thread_id=?")
        .get(threadId)?.n ?? 0,
    );
    process.stderr.write(
      `Boot two's engine went idle before committing a ${killAfter} frame: thread ${thread?.status.state ?? "absent"}, queue ${JSON.stringify({ paused: queue.paused, reason: queue.reason, pending: queue.pendingCount ?? 0, messages: queue.messages.length })}, ${frames} stored frame(s)\n`,
    );
  } catch (error) {
    process.stderr.write(
      `Boot two's engine went idle before committing a ${killAfter} frame; its state could not be read: ${String(error)}\n`,
    );
  }
  process.exitCode = 1;
});
