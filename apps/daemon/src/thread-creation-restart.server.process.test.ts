import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { transitionHarness } from "./engine/transition-test-support.ts";
import { startServer } from "./server.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { Client, token } from "./socket-test-support.ts";
import { repository, connect, command, git } from "./thread-creation-test-support.ts";

const Notice = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), url: z.string().url() }),
  z.object({ type: z.literal("created"), path: z.string() }),
]);
test("a crash before acceptance cleans its journaled checkout on reopen and the original draft can be retried", async () => {
  const h = transitionHarness();
  await repository(h.home);
  const before = (
    await git("git", ["-C", h.home, "for-each-ref", "refs/heads", "--format=%(refname)"])
  ).stdout;
  const entry = join(h.home, "creation-crash.mjs");
  await writeFile(
    entry,
    `
    import { Store, Engine, AdapterRegistry } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    import { startServer } from ${JSON.stringify(new URL("./server.ts", import.meta.url).href)};
    import { WorkspaceRuntime } from ${JSON.stringify(new URL("./workspace-runtime.ts", import.meta.url).href)};
    import { GitService } from '@ace/git';
    import { Capabilities } from '@ace/protocol';
    const store = new Store(${JSON.stringify(join(h.home, "events.sqlite"))});
    const registry = new AdapterRegistry();
    registry.register({ provider: 'codex', capabilities: () => Capabilities.parse({ steer: false, interruptCascades: false, resume: false, fork: false, subagentTranscripts: false, backgroundTaskControl: false, backgroundVisibility: 'none', planMode: false, tokenUsage: false, imageInput: false, rewindFiles: false }),
      createTranslator: () => ({ translate: () => [], tick: () => [] }),
      openSession: async () => { throw new Error('No provider session before acceptance'); },
    }, { installed: true, auth: 'logged_in', loginHint: 'synthetic' });
    const engine = new Engine(store, { registry });
    await engine.ready();
    class GatedGit extends GitService {
      async createWorktree(options) {
        const tree = await super.createWorktree(options);
        process.send({ type: 'created', path: tree.path });
        await new Promise(() => {});
        return tree;
      }
    }
    const runtime = new WorkspaceRuntime(store, ${JSON.stringify(join(h.home, "data"))}, () => 1000, { gitService: new GatedGit() });
    const server = await startServer({ store, engine, handler: engine.handler, workspaceActions: runtime, port: 0, hostId: 'host', token: ${JSON.stringify(token)} });
    process.send({ type: 'ready', url: server.url });
  `,
  );
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, ACE_HOME: h.home, HOME: h.home, USERPROFILE: h.home },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exited = once(child, "exit");
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const notices: z.infer<typeof Notice>[] = [];
  let notify: (() => void) | undefined;
  child.on("message", (value: unknown) => {
    notices.push(Notice.parse(value));
    notify?.();
  });
  async function notice(type: "ready" | "created") {
    for (;;) {
      const found = notices.find((row) => row.type === type);
      if (found) return found;
      await Promise.race([
        new Promise<void>((resolve) => {
          notify = resolve;
        }),
        exited.then(() => {
          throw new Error(`Child exited: ${errors}`);
        }),
      ]);
    }
  }
  let client: Client | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let runtime: WorkspaceRuntime | undefined;
  const payload = {
    type: "thread.create" as const,
    threadId: ThreadId.parse("crashed"),
    workspaceId: h.workspace,
    provider: "codex" as const,
    mode: "worktree" as const,
    input: [{ type: "text" as const, text: "Original draft after crash" }],
  };
  try {
    const ready = await notice("ready");
    if (ready.type !== "ready") throw new Error("Expected ready");
    client = await connect(ready.url);
    client.send({
      type: "command",
      command: Command.parse({ id: "crashed", deviceId: "device", payload }),
    });
    const created = await notice("created");
    if (created.type !== "created") throw new Error("Expected created checkout");
    expect(await readFile(join(created.path, "file.txt"), "utf8")).toBe("Synthetic\n");
    child.kill("SIGKILL");
    await exited;
    await client.close();
    await h.reopen();
    runtime = new WorkspaceRuntime(h.store, join(h.home, "data"), () => 1000);
    server = await startServer({
      store: h.store,
      engine: h.engine,
      handler: h.engine.handler,
      workspaceActions: runtime,
      port: 0,
      hostId: "host",
      token,
    });
    client = await connect(server.url);
    expect(await command(client, "crashed", payload)).toMatchObject({
      ok: true,
      threadId: payload.threadId,
    });
    await h.engine.flush();
    expect(h.inputs.map((row) => row.text)).toEqual(["Original draft after crash"]);
    expect(await runtime.git.listWorktrees(h.home)).toHaveLength(2);
    // Only the accepted replacement remains; the orphan cannot accumulate another branch.
    const heads = (
      await git("git", ["-C", h.home, "for-each-ref", "refs/heads", "--format=%(refname)"])
    ).stdout;
    expect(heads.trim().split("\n")).toHaveLength(before.trim().split("\n").length + 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await client?.close();
    await server?.close();
    await runtime?.close();
    await h.close();
  }
});
