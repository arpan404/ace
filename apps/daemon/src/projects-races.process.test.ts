import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnGitProcess as spawn } from "@ace/git";
import { mkdtemp, mkdir, rename, symlink, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CommandId, type WorkspaceCloneProgress } from "@ace/protocol";
import { projectFixture } from "./projects-test-support.ts";
import type { GitProcessRuntime } from "@ace/git";

// Deterministic process gates; not executed (tests run at merge).
function metadataGate(matches: (args: string[]) => boolean) {
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  let child: ChildProcessWithoutNullStreams | undefined;
  let held = false;
  return {
    ready: ready.promise,
    exited: exited.promise,
    spawn: (
      command: string,
      args: string[],
      options: Parameters<GitProcessRuntime["spawn"]>[2],
    ) => {
      if (held || !matches(args)) return spawn(command, args, options);
      held = true;
      const code =
        'const {spawn}=require("node:child_process"); const [mode,bin,...args]=process.argv.slice(1); process.on("SIGUSR1",()=>{const child=spawn(bin,args,{stdio:mode==="pinned"?["inherit","inherit","inherit",3]:["inherit","inherit","inherit"]}); child.on("error",()=>process.exit(125)); child.on("exit",code=>process.exit(code??1));}); process.stderr.write("gate-ready\\n"); setInterval(()=>{},1000);';
      child = spawn(
        process.execPath,
        ["-e", code, options.stdio.length > 3 ? "pinned" : "plain", command, ...args],
        options,
      );
      child.stderr.once("data", () => ready.resolve());
      child.once("close", () => exited.resolve());
      return child;
    },
    release() {
      child?.kill("SIGUSR1");
    },
  };
}

test.skipIf(process.platform === "win32")(
  "cancelling during post-transfer inspection never registers or completes a clone",
  async () => {
    const gate = metadataGate((args) => args.includes("rev-parse"));
    const f = await projectFixture({
      git: { processRuntime: { spawn: gate.spawn } },
      gitPolicy: { validateUrl() {}, protocols: ["file"] },
    });
    try {
      const source = join(f.root, "source");
      await mkdir(source);
      await f.git(source, ["init"]);
      const progress: WorkspaceCloneProgress[] = [];
      const stop = f.projects.onProgress((_owner, value) => progress.push(value));
      const clone = f.command(
        { type: "workspace.clone", parent: f.root, name: "clone", url: `file://${source}` },
        "late-cancel",
      );
      await gate.ready;
      const cancel = f.read({
        op: "workspace.clone.cancel",
        commandId: CommandId.parse("late-cancel"),
      });
      // Cancellation must stop this metadata child; releasing the gate would mask that behavior.
      expect(await clone).toMatchObject({ ok: false, error: "clone_cancelled" });
      expect((await cancel).result).toMatchObject({ kind: "cancelled" });
      expect(f.projects.catalog.recent(100)).toEqual([]);
      expect(progress.some((p) => p.phase === "completed")).toBe(false);
      expect(progress.at(-1)?.phase).toBe("cancelled");
      stop();
    } finally {
      gate.release();
      await f.close();
    }
  },
);

test("cancelling during final root validation prevents a clone commit after all Git children exit", async () => {
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let root = "";
  let hold = false;
  const f = await projectFixture({
    gitPolicy: { validateUrl() {}, protocols: ["file"] },
    roots: async () => {
      if (hold) {
        hold = false;
        ready.resolve();
        await release.promise;
      }
      return [root];
    },
    git: {
      processRuntime: {
        spawn(command, args, options) {
          const child = spawn(command, args, options);
          if (args.includes("config") && args.includes("init.defaultBranch"))
            child.once("close", () => {
              hold = true;
            });
          return child;
        },
      },
    },
  });
  root = f.root;
  try {
    const source = join(root, "source");
    await mkdir(source);
    await f.git(source, ["init"]);
    const progress: WorkspaceCloneProgress[] = [];
    const stop = f.projects.onProgress((_owner, value) => progress.push(value));
    const clone = f.command(
      { type: "workspace.clone", parent: root, name: "clone", url: `file://${source}` },
      "commit-cancel",
    );
    await ready.promise;
    const cancel = f.read({
      op: "workspace.clone.cancel",
      commandId: CommandId.parse("commit-cancel"),
    });
    release.resolve();
    expect(await clone).toMatchObject({ ok: false, error: "clone_cancelled" });
    expect((await cancel).result).toMatchObject({ kind: "cancelled" });
    expect(f.projects.catalog.recent(100)).toEqual([]);
    expect(progress.some((p) => p.phase === "completed")).toBe(false);
    stop();
  } finally {
    release.resolve();
    await f.close();
  }
});

test.skipIf(process.platform === "win32")(
  "project shutdown kills stalled metadata and awaits its exit before resolving",
  async () => {
    const gate = metadataGate((args) => args.includes("rev-parse"));
    const f = await projectFixture({ git: { processRuntime: { spawn: gate.spawn } } });
    try {
      const pending = f.command({ type: "workspace.add", path: f.root });
      await gate.ready;
      let exited = false;
      void gate.exited.then(() => {
        exited = true;
      });
      await f.projects.close();
      expect(exited).toBe(true);
      expect(await pending).toMatchObject({ ok: false });
      expect(f.projects.catalog.recent(100)).toEqual([]);
    } finally {
      gate.release();
      await f.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "replacing a creation directory cannot redirect git init or gitignore writes outside roots",
  async () => {
    const gate = metadataGate((args) => args.includes("check-ref-format"));
    const f = await projectFixture({ git: { processRuntime: { spawn: gate.spawn } } });
    const outside = await mkdtemp(join(tmpdir(), "ace-project-outside-"));
    try {
      const path = join(f.root, "new");
      const held = join(f.root, "held");
      const pending = f.command({
        type: "workspace.create",
        parent: f.root,
        name: "new",
        git: { initialBranch: "main" },
        gitignore: "secret/\n",
      });
      await gate.ready;
      await rename(path, held);
      await symlink(outside, path);
      gate.release();
      expect(await pending).toMatchObject({ ok: false });
      await expect(stat(join(outside, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(outside, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(held, ".gitignore"), "utf8")).toBe("secret/\n");
      expect(f.projects.catalog.recent(100)).toEqual([]);
    } finally {
      gate.release();
      await f.close();
      await rm(outside, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "replacing a folder during inspection cannot register a stale project pathname",
  async () => {
    const gate = metadataGate(
      (args) => args.includes("symbolic-ref") && args.includes("refs/remotes/origin/HEAD"),
    );
    const f = await projectFixture({ git: { processRuntime: { spawn: gate.spawn } } });
    try {
      const path = join(f.root, "repo");
      await mkdir(path);
      await f.git(path, ["init"]);
      const pending = f.command({ type: "workspace.add", path });
      await gate.ready;
      await rename(path, join(f.root, "held"));
      await mkdir(path);
      await writeFile(join(path, "replacement"), "different identity");
      gate.release();
      expect(await pending).toMatchObject({ ok: false, error: "project_path_changed" });
      expect(f.projects.catalog.recent(100)).toEqual([]);
    } finally {
      gate.release();
      await f.close();
    }
  },
);

test("folder browsing refuses a directory replaced while roots are being resolved", async () => {
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let root = "";
  let hold = false;
  const f = await projectFixture({
    roots: async () => {
      if (hold) {
        hold = false;
        ready.resolve();
        await release.promise;
      }
      return [root];
    },
  });
  root = f.root;
  const outside = await mkdtemp(join(tmpdir(), "ace-browse-outside-"));
  try {
    await mkdir(join(outside, "private-name"));
    const path = join(f.root, "browse");
    await mkdir(path);
    hold = true;
    const browsing = f.read({ op: "fs.browse", path, limit: 10, showHidden: true });
    await ready.promise;
    await rename(path, join(f.root, "held"));
    await symlink(outside, path);
    release.resolve();
    expect((await browsing).result).toMatchObject({ kind: "error", code: "project_path_changed" });
  } finally {
    release.resolve();
    await f.close();
    await rm(outside, { recursive: true, force: true });
  }
});

test("project inspection still reports metadata when full status enumeration is unavailable", async () => {
  const f = await projectFixture({
    git: {
      processRuntime: {
        spawn(command, args, options) {
          if (args.includes("status"))
            return spawn(process.execPath, ["-e", "process.exit(76)"], options);
          return spawn(command, args, options);
        },
      },
    },
  });
  try {
    const path = join(f.root, "repo");
    await mkdir(path);
    await f.git(path, ["init", "--initial-branch=trunk"]);
    await writeFile(join(path, "untracked"), "not needed for metadata");
    expect((await f.read({ op: "workspace.inspect", path })).result).toMatchObject({
      kind: "inspection",
      path,
      git: { root: path, branch: "trunk", remotes: [] },
    });
  } finally {
    await f.close();
  }
});

test("cancellation after completed progress cannot contradict a successful clone receipt", async () => {
  const f = await projectFixture({ gitPolicy: { validateUrl() {}, protocols: ["file"] } });
  try {
    const source = join(f.root, "source");
    await mkdir(source);
    await f.git(source, ["init"]);
    const cancelled = Promise.withResolvers<Awaited<ReturnType<typeof f.read>>>();
    const stop = f.projects.onProgress((_owner, progress) => {
      if (progress.phase === "completed")
        void f
          .read({ op: "workspace.clone.cancel", commandId: CommandId.parse("completed-clone") })
          .then(cancelled.resolve, cancelled.reject);
    });
    const receipt = await f.command(
      { type: "workspace.clone", parent: f.root, name: "complete", url: `file://${source}` },
      "completed-clone",
    );
    expect(receipt).toMatchObject({ ok: true });
    expect((await cancelled.promise).result).toMatchObject({
      kind: "error",
      code: "clone_not_running",
    });
    expect(f.projects.catalog.recent(100)).toEqual([receipt.workspace]);
    stop();
  } finally {
    await f.close();
  }
});
