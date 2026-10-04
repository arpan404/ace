import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnGitProcess as spawn } from "@ace/git";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, CommandId, Project, type WorkspaceCloneProgress } from "@ace/protocol";
import { GitError } from "@ace/git";
import { projectFixture, projectServer, until } from "./projects-test-support.ts";

// File transport exists only in this fixture. Production command inputs cannot enable it.
const fixturePolicy = {
  validateUrl(value: string) {
    if (!value.startsWith("file://"))
      throw new GitError("invalid_argument", "Expected file fixture");
  },
  protocols: ["file"],
};
test("clone uses host git against a file-protocol bare fixture and publishes progress before registering", async () => {
  const f = await projectFixture({ gitPolicy: fixturePolicy });
  try {
    const source = join(f.root, "source");
    await mkdir(source);
    await f.git(source, ["init"]);
    await writeFile(join(source, "README.md"), "cloned contents\n");
    await f.git(source, ["add", "README.md"]);
    await f.git(source, [
      "-c",
      "user.name=ace test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    const bare = join(f.root, "source.git");
    await f.git(f.root, ["clone", "--bare", "--", source, bare]);
    const progress: WorkspaceCloneProgress[] = [];
    const duringTransfer: unknown[][] = [];
    const stop = f.projects.onProgress((_device, value) => {
      progress.push(value);
      if (["starting", "receiving", "resolving", "checkout"].includes(value.phase))
        duringTransfer.push(f.projects.catalog.recent(100));
    });
    const result = await f.command(
      {
        type: "workspace.clone",
        parent: f.root,
        name: "clone",
        url: new URL(`file://${bare}`).href,
      },
      "clone",
    );
    expect(result).toMatchObject({
      ok: true,
      workspace: { path: join(f.root, "clone"), name: "clone" },
      inspection: { git: { branch: "trunk", defaultBranch: "trunk" } },
    });
    expect(await readFile(join(f.root, "clone", "README.md"), "utf8")).toBe("cloned contents\n");
    expect(progress[0]).toMatchObject({ commandId: "clone", phase: "starting" });
    expect(progress).toEqual(
      expect.arrayContaining([expect.objectContaining({ phase: "receiving", percent: 100 })]),
    );
    expect(progress.at(-1)).toMatchObject({ phase: "completed", percent: 100 });
    expect(duringTransfer.length).toBeGreaterThan(0);
    expect(duringTransfer.every((projects) => projects.length === 0)).toBe(true);
    expect(
      await f.command(
        { type: "workspace.clone", parent: f.root, name: "clone", url: `file://${bare}` },
        "clone",
      ),
    ).toEqual(result);
    expect(f.projects.catalog.recent(100)).toEqual([Project.parse(result.workspace)]);
    stop();
  } finally {
    await f.close();
  }
});

test("production cloning rejects file ext and credential URLs before creating the destination", async () => {
  const f = await projectFixture();
  try {
    for (const [index, url] of [
      "file:///tmp/source.git",
      "ext::sh -c echo injected",
      "https://user:password@example.com/repo.git",
      "-u",
      "ftp://example.com/repo.git",
      "git://example.com/repo.git",
      "https://example.com/repo.git\n--config=evil",
    ].entries()) {
      expect(
        await f.command({ type: "workspace.clone", parent: f.root, name: `denied-${index}`, url }),
      ).toMatchObject({ ok: false, error: "git_invalid_argument" });
      expect(f.projects.catalog.recent(100)).toEqual([]);
      await expect(stat(join(f.root, `denied-${index}`))).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    await f.close();
  }
});

test("clone cancellation kills the owned child before replying and never registers its partial directory", async () => {
  const closed = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const f = await projectFixture({
    git: {
      timeoutMs: 15_000,
      processRuntime: {
        spawn(command, args, options) {
          if (!args.includes("clone")) return spawn(command, args, options);
          const child = spawn(
            process.execPath,
            [
              "-e",
              'require("node:fs").closeSync(3); process.stderr.write("Receiving objects: 1%\\r"); setInterval(() => {}, 1000);',
            ],
            options,
          );
          child.once("close", () => closed.resolve());
          return child;
        },
      },
    },
  });
  try {
    const progress: WorkspaceCloneProgress[] = [];
    const stop = f.projects.onProgress((_device, value) => {
      progress.push(value);
      if (value.phase === "receiving") started.resolve();
    });
    const clone = f.command(
      {
        type: "workspace.clone",
        parent: f.root,
        name: "cancelled",
        url: "https://example.invalid/repo.git",
      },
      "cancel-me",
    );
    await started.promise;
    expect(
      (
        await f.read(
          { op: "workspace.clone.cancel", commandId: CommandId.parse("cancel-me") },
          "other-device",
        )
      ).result,
    ).toMatchObject({ kind: "error", code: "forbidden" });
    let exited = false;
    void closed.promise.then(() => {
      exited = true;
    });
    expect(
      (await f.read({ op: "workspace.clone.cancel", commandId: CommandId.parse("cancel-me") }))
        .result,
    ).toMatchObject({ kind: "cancelled" });
    expect(exited).toBe(true);
    expect(await clone).toMatchObject({ ok: false, error: "clone_cancelled" });
    expect(progress.at(-1)).toMatchObject({ phase: "cancelled" });
    expect(f.projects.catalog.recent(100)).toEqual([]);
    expect(
      await f.command(
        {
          type: "workspace.clone",
          parent: f.root,
          name: "cancelled",
          url: "https://example.invalid/repo.git",
        },
        "cancel-me",
      ),
    ).toMatchObject({ ok: false, error: "clone_cancelled" });
    stop();
  } finally {
    await f.close();
  }
});

test("revoking a paired device cancels its stalled clone even when no more progress arrives", async () => {
  const ready = Promise.withResolvers<void>();
  const f = await projectFixture({
    git: {
      timeoutMs: 15_000,
      processRuntime: {
        spawn(command, args, options) {
          if (!args.includes("clone")) return spawn(command, args, options);
          const child = spawn(
            process.execPath,
            [
              "-e",
              'require("node:fs").closeSync(3); process.stderr.write("Receiving objects: 1%\\r"); setInterval(() => {}, 1000);',
            ],
            options,
          );
          return child;
        },
      },
    },
  });
  try {
    const device = f.store.devices.create("Remote", ["projects"], 1000).device;
    const stop = f.projects.onProgress((_owner, value) => {
      if (value.phase === "receiving") ready.resolve();
    });
    const clone = f.projects.execute(
      Command.parse({
        id: "revoked-clone",
        deviceId: device.id,
        payload: {
          type: "workspace.clone",
          parent: f.root,
          name: "revoked",
          url: "https://example.invalid/repo.git",
        },
      }),
      () => f.store.devices.get(device.id)?.revokedAt === null,
    );
    await ready.promise;
    f.store.devices.revoke(device.id, 2000);
    expect(await clone).toMatchObject({ ok: false, error: "clone_cancelled" });
    expect(f.projects.catalog.recent(100)).toEqual([]);
    stop();
  } finally {
    await f.close();
  }
});

test.skipIf(process.platform === "win32")(
  "an admitted clone survives disconnect and a reconnect receives the same durable receipt",
  async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    const f = await projectFixture({
      gitPolicy: fixturePolicy,
      git: {
        timeoutMs: 15_000,
        processRuntime: {
          spawn(command, args, options) {
            if (!args.includes("clone")) return spawn(command, args, options);
            // The fixture gate waits for a host signal, then runs the real installed Git with argv.
            const code =
              'const {spawn}=require("node:child_process"); const [bin,...args]=process.argv.slice(1); process.on("SIGUSR1",()=>{const child=spawn(bin,args,{stdio:["ignore","inherit","inherit",3]}); child.on("exit",code=>process.exit(code??1));}); process.stderr.write("Receiving objects: 0%\\r"); setInterval(()=>{},1000);';
            child = spawn(process.execPath, ["-e", code, command, ...args], options);
            return child;
          },
        },
      },
    });
    const server = await projectServer(f);
    try {
      const source = join(f.root, "seed");
      await mkdir(source);
      await f.git(source, ["init"]);
      await writeFile(join(source, "README.md"), "survived reconnect\n");
      await f.git(source, ["add", "README.md"]);
      await f.git(source, [
        "-c",
        "user.name=ace test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "fixture",
      ]);
      const bare = join(f.root, "seed.git");
      await f.git(f.root, ["clone", "--bare", "--", source, bare]);
      const client = await server.connect();
      const command = Command.parse({
        id: "reconnecting-clone",
        deviceId: "owner",
        payload: {
          type: "workspace.clone",
          parent: f.root,
          name: "resumed",
          url: `file://${bare}`,
        },
      });
      client.send({ type: "command", command });
      await until(
        client,
        (message) => message.type === "workspace.clone.progress" && message.phase === "receiving",
      );
      await client.close();
      const reconnected = await server.connect();
      reconnected.send({ type: "command", command });
      if (!child) throw new Error("Clone process did not start");
      child.kill("SIGUSR1");
      const receipt = await until(reconnected, (message) => message.type === "commandResult");
      expect(receipt).toMatchObject({ ok: true, workspace: { path: join(f.root, "resumed") } });
      expect(await readFile(join(f.root, "resumed", "README.md"), "utf8")).toBe(
        "survived reconnect\n",
      );
      reconnected.send({ type: "command", command });
      expect(await until(reconnected, (message) => message.type === "commandResult")).toEqual(
        receipt,
      );
      expect(f.projects.catalog.recent(100)).toHaveLength(1);
    } finally {
      await server.close();
      await f.close();
    }
  },
);
