import { Store, Engine, AdapterRegistry } from "../index.ts";
import { Command } from "@ace/protocol";
import { syntheticProvider } from "../testing/long-thread-provider.ts";
import { ManualClock } from "./test-support.ts";
import { z } from "zod";
const [path, root] = process.argv.slice(2);
if (!path || !root) throw new Error("Missing fixture paths");
const mode = z.enum(["committed", "buffered"]).default("committed").parse(process.argv[4]);
// Keep the fixture alive until the parent kills it, including while unref intake timers wait.
process.on("message", () => {});
const timer = new ManualClock();
const store = new Store(path, undefined, { bufferScheduler: { delay: timer.setTimer } });
const provider = syntheticProvider();
const registry = new AdapterRegistry();
registry.register(provider.adapter, { installed: true, auth: "logged_in", loginHint: "synthetic" });
const engine = new Engine(store, { registry, threadId: () => "committed-thread" });
const workspace = store.createWorkspace(root, "Synthetic");
const command = Command.parse({
  id: "start",
  deviceId: "synthetic",
  payload: {
    type: "thread.create",
    workspaceId: workspace,
    provider: "codex",
    input: [{ type: "text", text: "synthetic" }],
  },
});
store.recordCommand(command.id, command.deviceId, () => engine.handler.handle(command, store));
await engine.flush();
const acknowledgements = Array.from({ length: 1000 }, () =>
  provider.frame({ kind: "delta", append: "x" }),
);
await Promise.all(acknowledgements);
await engine.flush();
if (mode === "buffered") await provider.frame({ kind: "delta", append: "unflushed tail" });
process.send?.({ seq: store.headSeq() });
