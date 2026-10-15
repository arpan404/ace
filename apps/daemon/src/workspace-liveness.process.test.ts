import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { spawnGitProcess } from "@ace/git";
import { Command, Thread } from "@ace/protocol";
import { stubHandler } from "./commands.ts";
import { startServer } from "./server.ts";
import { token } from "./socket-test-support.ts";
import { Store } from "./store.ts";
import { command, connect } from "./thread-creation-test-support.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const git = promisify(execFile);
/** Holds a git child until `release` exists, standing in for a slow hook or network. */
const waitFor = (release: string) =>
  `while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done`;

async function workspace(options: { holdPush?: string; pushing?: () => void } = {}) {
  const home = await mkdtemp(join(tmpdir(), "ace-workspace-liveness-"));
  const root = join(home, "repo");
  await mkdir(root);
  await git("git", ["init", "-q", "--initial-branch=main", root]);
  await git("git", ["-C", root, "config", "user.name", "Fixture"]);
  await git("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(root, "file.txt"), "one\n");
  await git("git", ["-C", root, "add", "file.txt"]);
  await git("git", ["-C", root, "commit", "-qm", "Initial"]);
  const store = new Store(join(home, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const thread = Thread.parse({
    id: "thread",
    workspaceId,
    provider: "codex",
    title: "Fixture",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, home, () => 1000, {
    git: {
      transportProtocols: ["file"],
      processRuntime: {
        spawn(binary, args, spawnOptions) {
          if (!options.holdPush || !args.includes("push"))
            return spawnGitProcess(binary, args, spawnOptions);
          options.pushing?.();
          return spawnGitProcess(
            "/bin/sh",
            ["-c", `${waitFor(options.holdPush)}; exec "$@"`, "sh", binary, ...args],
            spawnOptions,
          );
        },
      },
    },
  });
  const server = await startServer({
    store,
    handler: stubHandler(),
    workspaceActions: runtime,
    port: 0,
    token,
    hostId: "host",
  });
  const head = async () =>
    (await git("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim() || null;
  return {
    home,
    root,
    thread,
    server,
    head,
    async close() {
      await server.close();
      await runtime.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("a ping is answered while a git.commit blocked on a slow hook runs", async () => {
  const f = await workspace();
  try {
    const release = join(f.home, "release-hook");
    const hook = join(f.root, ".git", "hooks", "pre-commit");
    await writeFile(hook, `#!/bin/sh\n${waitFor(release)}\n`);
    await chmod(hook, 0o755);
    await writeFile(join(f.root, "file.txt"), "two\n");
    const client = await connect(f.server.url);
    const committed = command(client, "slow-commit", {
      type: "git.commit",
      threadId: f.thread.id,
      expectedHead: await f.head(),
      message: "Change behind a slow hook",
    });
    // The pong comes back while the hook still holds the commit.
    const pong = new Promise<string>((resolve) =>
      client.socket.on("message", (data) => {
        if (JSON.parse(data.toString()).type === "pong") resolve("pong");
      }),
    );
    client.send({ type: "ping" });
    expect(await pong).toBe("pong");
    await writeFile(release, "");
    expect(await committed).toMatchObject({ ok: true });
    await client.close();
  } finally {
    await f.close();
  }
});

test("a push that completes after the client disconnected reports success on replay", async () => {
  const pushing = Promise.withResolvers<void>();
  const home = await mkdtemp(join(tmpdir(), "ace-push-release-"));
  const release = join(home, "release-push");
  const f = await workspace({ holdPush: release, pushing: () => pushing.resolve() });
  try {
    const remote = join(f.home, "remote.git");
    await git("git", ["init", "-q", "--bare", remote]);
    await git("git", ["-C", f.root, "remote", "add", "origin", pathToFileURL(remote).href]);
    const first = await connect(f.server.url);
    first.send({
      type: "command",
      command: Command.parse({
        id: "push-across-reconnect",
        deviceId: "device",
        payload: { type: "git.push", threadId: f.thread.id, remote: "origin" },
      }),
    });
    await pushing.promise;
    // The socket that asked for the push goes away while git is still pushing.
    await first.close();
    await writeFile(release, "");
    const second = await connect(f.server.url);
    expect(
      await command(second, "push-across-reconnect", {
        type: "git.push",
        threadId: f.thread.id,
        remote: "origin",
      }),
    ).toMatchObject({ ok: true });
    expect((await git("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim()).toBe(
      await f.head(),
    );
    await second.close();
  } finally {
    await f.close();
    await rm(home, { recursive: true, force: true });
  }
});
