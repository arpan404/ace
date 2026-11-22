// A daemon process whose Cursor threads open the real host (cursor-real-host-support.ts), killed
// by its parent at an exact commit point: as soon as the outermost transaction that committed a
// frame of the kind named by the argument returns, it writes the signal file and freezes its
// thread, so nothing after that commit runs.
import { writeFileSync } from "node:fs";
import { Store } from "../store.ts";
import { Engine } from "./index.ts";
import { AdapterRegistry } from "./registry.ts";
import { realHostAdapter } from "./cursor-real-host-support.ts";

const [database, entry, home, sends, killAfter, signal] = process.argv.slice(2);
if (!database || !entry || !home || !sends || !killAfter || !signal)
  throw new Error("Missing arguments");
const store = new Store(database);
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
// The last daemon was killed outright: its process groups are gone, as the check would show.
const engine = new Engine(store, {
  registry,
  selectInstance: () => "account-a",
  cursorPreviousProcessesGone: async () => true,
});
void engine.flush();
