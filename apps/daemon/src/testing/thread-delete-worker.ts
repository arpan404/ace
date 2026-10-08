import { join } from "node:path";
import { z } from "zod";
import { Command } from "@ace/protocol";
import { Engine, AdapterRegistry } from "../engine/index.ts";
import { Store } from "../store.ts";
import { startServer } from "../server.ts";
import { syntheticProvider } from "./long-thread-provider.ts";

/** A disposable daemon whose session close pauses at an explicit crash-test barrier. */
const [home, token] = z
  .tuple([z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/)])
  .parse(process.argv.slice(2));
const store = new Store(join(home, "events.sqlite"));
const workspace = store.createWorkspace(home, "Crash fixture");
const provider = syntheticProvider();
const registry = new AdapterRegistry();
registry.register(
  {
    ...provider.adapter,
    async openSession(ctx) {
      const session = await provider.adapter.openSession(ctx);
      return {
        ...session,
        async close() {
          process.stdout.write(JSON.stringify({ type: "closing" }) + "\n");
          await new Promise<void>(() => {});
        },
      };
    },
  },
  { installed: true, auth: "logged_in", loginHint: "fake" },
);
const engine = new Engine(store, { registry });
await engine.ready();
const command = Command.parse({
  id: "create",
  deviceId: "device",
  payload: {
    type: "thread.create",
    threadId: "crash-thread",
    workspaceId: workspace,
    provider: "codex",
    input: [{ type: "text", text: "fake input" }],
  },
});
const result = store.recordCommand(command.id, command.deviceId, () =>
  engine.handler.handle(command, store),
);
if (!result.ok) throw new Error(result.error);
await engine.flush();
const server = await startServer({
  store,
  engine,
  handler: engine.handler,
  token,
  hostId: "fixture",
  port: 0,
});
process.stdout.write(JSON.stringify({ type: "ready", url: server.url }) + "\n");
