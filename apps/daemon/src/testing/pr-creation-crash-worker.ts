import { join } from "node:path";
import { z } from "zod";
import { Command } from "@ace/protocol";
import { GitService } from "@ace/git";
import { createCommandRunner } from "@ace/forge";
import { Store } from "../store.ts";
import { Engine, AdapterRegistry } from "../engine/index.ts";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { syntheticProvider } from "./long-thread-provider.ts";

const config = z
  .object({
    home: z.string(),
    directory: z.string(),
    ghDirectory: z.string(),
    executable: z.string(),
    commands: z.array(Command).length(16),
  })
  .parse(JSON.parse(z.string().parse(process.argv[2])));

/** Pause after real Git has settled, before the physical lease can be accepted. */
class GatedGit extends GitService {
  override async createWorktree(options: Parameters<GitService["createWorktree"]>[0]) {
    const tree = await super.createWorktree(options);
    process.send?.({ type: "checkout", path: tree.path });
    await new Promise<void>(() => {});
    return tree;
  }
}
process.on("message", () => {});
const store = new Store(join(config.home, "events.sqlite"));
const registry = new AdapterRegistry();
registry.register(syntheticProvider().adapter, {
  installed: true,
  auth: "logged_in",
  loginHint: "synthetic",
});
const engine = new Engine(store, { registry });
await engine.ready();
const runtime = new WorkspaceRuntime(store, config.directory, () => 1000, {
  gitService: new GatedGit(),
  prRemote: () => "origin",
  changeWorkspace: (...args) => engine.changeWorkspace(...args),
  reconcileThread: (id) => engine.reconcileThread(id),
  forgeRunner: (cwd) => {
    const runner = createCommandRunner({
      cwd,
      env: {
        FORGE_FIXTURE: join(config.ghDirectory, "fixtures.json"),
        FORGE_STATE: join(config.ghDirectory, "state.json"),
      },
    });
    return (request) => runner({ ...request, command: config.executable });
  },
});
const operations = [];
for (const command of config.commands) {
  const progress = await runtime.creationDrafts.begin(command, command.deviceId, () => {});
  operations.push(progress);
}
const first = config.commands[0];
const progress = operations[0];
if (!first || !progress) throw new Error("Missing crash preparation");
// Exercise both interrupted states without cancelling the checkout that owns real resources.
operations.at(-1)?.stop("cancel");
await runtime.execute(first, () => true, progress);
throw new Error("Crash barrier unexpectedly completed");
