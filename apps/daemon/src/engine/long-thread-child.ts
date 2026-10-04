import { Store, Engine, AdapterRegistry } from "../index.ts";
import { Command } from "@ace/protocol";
import { syntheticProvider } from "../testing/long-thread-provider.ts";
const [path, root] = process.argv.slice(2);
if (!path || !root) throw new Error("Missing fixture paths");
const store = new Store(path);
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
process.send?.("committed");
