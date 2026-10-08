import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { AdapterRegistry, startDaemon } from "@ace/daemon";
import { createTurnProvider, ScriptedTurnConfig } from "@ace/adapter-testkit";
import { Command, DeviceId, ThreadId } from "@ace/protocol";
import { Client } from "./socket-test-support.ts";
import { ManualClock } from "./engine/test-support.ts";
import { git } from "./test-git.ts";

async function launch(home: string) {
  const clock = new ManualClock();
  const registry = new AdapterRegistry();
  registry.register(
    createTurnProvider({
      provider: "codex",
      reply: "Ordinary thread continued",
      config: ScriptedTurnConfig.parse({}),
      now: clock.now,
      schedule: () => () => {},
    }),
    { installed: true, auth: "logged_in", loginHint: "scripted" },
  );
  const daemon = await startDaemon({
    config: {
      dataDir: home,
      cursorSdkHome: join(home, "cursor"),
      host: "127.0.0.1",
      port: 0,
      listen: "local",
      remotePort: 0,
      logLevel: "warn",
    },
    engine: { registry, clock, cursor: { env: { ...process.env, HOME: home, PATH: "" } } },
    accounts: { env: { ...process.env, HOME: home, PATH: "" } },
    providerStatus: { env: { ...process.env, HOME: home, PATH: "" } },
  });
  await daemon.engine?.flush();
  return daemon;
}

async function logs(home: string) {
  const directory = join(home, "logs");
  return (
    await Promise.all(
      (await readdir(directory)).map((file) => readFile(join(directory, file), "utf8")),
    )
  ).join("\n");
}

test.each(["existing", "cleaned worktree"])(
  "a main-schema live Deck with a %s workspace upgrades to ordinary threads and rejects retired messages safely",
  async (kind) => {
    const home = await mkdtemp(join(tmpdir(), "ace-offshift-upgrade-"));
    let daemon: Awaited<ReturnType<typeof launch>> | undefined;
    let client: Client | undefined;
    try {
      for (const file of ["events.sqlite", "conductor.sqlite"])
        await writeFile(
          join(home, file),
          gunzipSync(await readFile(new URL(`./fixtures/${file}.gz`, import.meta.url))),
        );
      // Only the fixture's ephemeral filesystem root changes; its stored live state is untouched.
      const workspace =
        kind === "existing" ? join(home, "workspace") : join(home, "deck-worktrees", "clean");
      if (kind === "existing") await mkdir(workspace);
      else {
        const repo = join(home, "repo");
        await mkdir(repo);
        git(repo, "init", "--initial-branch=main");
        git(repo, "config", "user.name", "Fixture");
        git(repo, "config", "user.email", "fixture@example.invalid");
        await writeFile(join(repo, "tracked.txt"), "original");
        git(repo, "add", "tracked.txt");
        git(repo, "commit", "-m", "Initial");
        git(repo, "worktree", "add", "-b", "clean", workspace);
        // Even a global automatic-recovery preference must not reopen a removed checkout.
        await writeFile(
          join(home, "settings.json"),
          JSON.stringify({ version: 2, settings: { "threads.continueAfterRestart": true } }),
        );
      }
      const fixture = new DatabaseSync(join(home, "events.sqlite"));
      try {
        fixture.prepare("UPDATE workspaces SET path=?").run(workspace);
        fixture.prepare("UPDATE engine_sessions SET cwd=?").run(workspace);
        fixture
          .prepare(
            "UPDATE threads SET client=json_set(client,'$.details.workspace.path',?,'$.details.worktree',?)",
          )
          .run(workspace, workspace);
        fixture
          .prepare(
            "UPDATE engine_state_records SET value=json_set(value,'$.agent.cwd',?) WHERE section='agents'",
          )
          .run(workspace);
        fixture
          .prepare(
            "UPDATE view_entities SET value=json_set(value,'$.cwd',?) WHERE collection='agents'",
          )
          .run(workspace);
      } finally {
        fixture.close();
      }
      const archive = await readFile(join(home, "conductor.sqlite"));
      daemon = await launch(home);
      expect(daemon.serviceStatus().find((service) => service.name === "engine")).toMatchObject({
        state: "ready",
      });
      const root = daemon.store.snapshotThread(ThreadId.parse("deck-root"));
      expect(root.thread?.title).toBe("Offshift: retained root");
      expect(Object.values(root.interactions)).toMatchObject([
        { state: "cancelled", request: { kind: "plan_review" } },
      ]);
      const worker = daemon.store.snapshotThread(ThreadId.parse("deck-worker"));
      expect(worker.thread).toMatchObject({
        title: "Deck lane retained",
        status: { state: "waiting" },
      });
      expect(Object.values(worker.interactions)).toMatchObject([
        { state: "expired", request: { title: "Private browser ownership" } },
      ]);
      if (kind === "cleaned worktree") {
        expect(await readdir(join(home, "deck-worktrees"))).toEqual([]);
        await mkdir(workspace);
      }
      // Browser recovery expires its own orphaned approval; the former lane still resumes normally.
      const engine = daemon.engine;
      if (!engine) throw new Error("Engine unavailable");
      expect(
        engine.handler.handle(
          Command.parse({
            id: "plain-resume",
            deviceId: "fixture",
            payload: {
              type: "queue.resume",
              threadId: "deck-worker",
              expectedRevision: engine.queue(ThreadId.parse("deck-worker")).revision,
            },
          }),
          daemon.store,
        ),
      ).toMatchObject({ ok: true });
      await engine.flush();
      const command = Command.parse({
        id: "plain-followup",
        deviceId: "fixture",
        payload: {
          type: "thread.send",
          threadId: "deck-worker",
          input: [{ type: "text", text: "Synthetic follow-up" }],
        },
      });
      expect(daemon.engine?.handler.handle(command, daemon.store)).toMatchObject({ ok: true });
      await daemon.engine?.flush();
      expect(
        Object.values(daemon.store.snapshotThread(ThreadId.parse("deck-worker")).items),
      ).toContainEqual(
        expect.objectContaining({
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text: "Ordinary thread continued" }],
        }),
      );
      client = new Client(daemon.url);
      await once(client.socket, "open");
      client.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: DeviceId.parse("old-client"),
        token: (await readFile(daemon.tokenPath, "utf8")).trim(),
      });
      expect(await client.next()).toMatchObject({ type: "welcome" });
      for (const message of [
        {
          type: "command",
          command: {
            id: "retired-command",
            deviceId: "old-client",
            payload: { type: "conductor.cancel", runId: "live-deck" },
          },
        },
        {
          type: "conductor.request",
          requestId: "retired-read",
          operation: { op: "list", limit: 10 },
        },
      ]) {
        client.socket.send(JSON.stringify(message));
        expect(await client.next()).toMatchObject({ type: "error", code: "invalid_message" });
        client.send({ type: "ping" });
        expect(await client.next()).toMatchObject({ type: "pong" });
      }
      await client.close();
      client = undefined;
      await daemon.close();
      daemon = await launch(home);
      expect(daemon.store.getThread(ThreadId.parse("deck-root"))?.title).toBe(
        "Offshift: retained root",
      );
      expect(daemon.store.getThread(ThreadId.parse("deck-worker"))?.title).toBe(
        "Deck lane retained",
      );
      expect(await readFile(join(home, "conductor.sqlite"))).toEqual(archive);
    } finally {
      await client?.close();
      await daemon?.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("first upgrade removes only clean Deck worktrees and logs retained uncommitted work without following symlinks", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-retired-worktrees-"));
  let daemon: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const repo = join(home, "repo");
    await mkdir(repo);
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.name", "Fixture");
    git(repo, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(repo, "tracked.txt"), "original");
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    git(repo, "add", "tracked.txt", ".gitignore");
    git(repo, "commit", "-m", "Initial");
    const directory = join(home, "deck-worktrees");
    const cases = ["clean", "tracked", "staged", "untracked", "hidden", "ignored", "locked"];
    for (const name of cases) git(repo, "worktree", "add", "-b", name, join(directory, name));
    await writeFile(join(directory, "tracked", "tracked.txt"), "uncommitted tracked");
    await writeFile(join(directory, "staged", "tracked.txt"), "uncommitted staged");
    git(join(directory, "staged"), "add", "tracked.txt");
    await writeFile(join(directory, "untracked", "new.txt"), "uncommitted new file");
    git(join(directory, "hidden"), "update-index", "--assume-unchanged", "tracked.txt");
    await writeFile(join(directory, "hidden", "tracked.txt"), "hidden uncommitted work");
    await writeFile(join(directory, "ignored", "ignored.txt"), "ignored uncommitted work");
    git(repo, "worktree", "lock", join(directory, "locked"));
    await symlink(repo, join(directory, "alias"), "dir");
    daemon = await launch(home);
    expect((await readdir(directory)).toSorted()).toEqual([
      "alias",
      "hidden",
      "ignored",
      "locked",
      "staged",
      "tracked",
      "untracked",
    ]);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(join(directory, "clean"));
    for (const name of ["hidden", "ignored", "locked", "staged", "tracked", "untracked", "alias"])
      expect(await logs(home)).toContain(`/deck-worktrees/${name}`);
    expect(await readFile(join(directory, "hidden", "tracked.txt"), "utf8")).toBe(
      "hidden uncommitted work",
    );
    expect(await readFile(join(directory, "untracked", "new.txt"), "utf8")).toBe(
      "uncommitted new file",
    );
    expect(await readFile(join(directory, "ignored", "ignored.txt"), "utf8")).toBe(
      "ignored uncommitted work",
    );
    await daemon.close();
    daemon = undefined;
    // A later clean tree belongs to the user now; cleanup is an upgrade pass, not ongoing deletion.
    git(join(directory, "tracked"), "restore", "tracked.txt");
    daemon = await launch(home);
    expect(await readFile(join(directory, "tracked", "tracked.txt"), "utf8")).toBe("original");
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("original");
  } finally {
    await daemon?.close();
    await rm(home, { recursive: true, force: true });
  }
});
