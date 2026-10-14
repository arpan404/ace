import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { spawnGitProcess } from "@ace/git";
import {
  Command,
  Thread,
  WorkspaceActionRequest,
  type ForgeLocalStack,
  type ForgeStackExpected,
  type ForgeStackOperation,
} from "@ace/protocol";
import {
  fakeGh,
  repository,
  stackChecksFixture,
  stackLayers,
  stackResponse,
} from "@ace/forge/testing";
import { Store } from "../store.ts";
import { WorkspaceRuntime } from "../workspace-runtime.ts";

/**
 * A native three-layer stack (model → api → ui) in a real checkout, a bare repository standing
 * in for GitHub's branches, and a fake `gh` answering stack reads with the heads a test sets.
 */
export const run = promisify(execFile);
export const names = ["model", "api", "ui"] as const;
export type Heads = Record<(typeof names)[number], string>;
export async function git(cwd: string, ...args: string[]) {
  return (await run("git", ["-C", cwd, ...args])).stdout.trim();
}

/** File contents a layer's commit writes, keyed by layer then path. */
export type LayerFiles = Partial<Record<(typeof names)[number], Record<string, string>>>;
/** Commit one layer per branch, each on the layer below it, starting from `base`. */
async function layers(
  root: string,
  base: string,
  label: string,
  files: LayerFiles = {},
): Promise<Heads> {
  const heads: Partial<Heads> = {};
  let parent = base;
  for (const name of names) {
    await git(root, "switch", "-qC", name, parent);
    for (const [path, text] of Object.entries(files[name] ?? {})) {
      await writeFile(join(root, path), text);
      await git(root, "add", "--", path);
    }
    await git(root, "commit", "-q", "--allow-empty", "-m", `${name} ${label}`);
    parent = heads[name] = await git(root, "rev-parse", "HEAD");
  }
  return { model: heads.model ?? "", api: heads.api ?? "", ui: heads.ui ?? "" };
}

export function local(heads: Heads, trunk: string): ForgeLocalStack {
  return {
    trunk: "main",
    currentBranch: "ui",
    branches: names.map((name, index) => ({
      name,
      head: heads[name],
      base: index === 0 ? trunk : heads[names[index - 1] ?? "model"],
      isCurrent: name === "ui",
      isMerged: false,
      isQueued: false,
      needsRebase: false,
      pr: {
        number: 7 + index,
        url: `https://github.com/octo/ace/pull/${7 + index}`,
        state: "OPEN",
      },
    })),
  };
}

/** GitHub's view of the stack with the given layer heads. */
export function host(heads: Heads) {
  const [checks] = structuredClone(stackChecksFixture["stack-checks"]);
  if (!checks) throw new Error("Missing stack checks fixture");
  const prs = checks.body.data.repository;
  prs.pr7.headRefOid = heads.model;
  prs.pr8.headRefOid = heads.api;
  prs.pr9.headRefOid = heads.ui;
  return {
    "stack-checks": [checks],
    graphql: [
      stackResponse(
        8,
        stackLayers.map((pr, index) => ({
          position: pr.position,
          pullRequest: { ...pr, headRefOid: heads[names[index] ?? "model"] },
        })),
      ),
    ],
  };
}

/** `lostAcknowledgement` pushes for real but reports no result, as a dropped connection would. */
export async function stackFixture(lostAcknowledgement = false) {
  const root = await mkdtemp(join(tmpdir(), "ace-stack-publish-"));
  const checkout = join(root, "checkout");
  const remote = join(root, "remote.git");
  const config = join(root, "push.gitconfig");
  await run("git", ["init", "-q", "-b", "main", checkout]);
  await run("git", ["init", "-q", "--bare", remote]);
  await git(checkout, "config", "user.name", "Test");
  await git(checkout, "config", "user.email", "test@example.invalid");
  await git(checkout, "commit", "-q", "--allow-empty", "-m", "Trunk");
  const trunk = await git(checkout, "rev-parse", "HEAD");
  const reviewed = await layers(checkout, trunk, "reviewed");
  await git(checkout, "remote", "add", "origin", "https://github.com/octo/ace.git");
  await git(checkout, "push", "-q", remote, "main", ...names);
  // The bare repository stands in for GitHub only when Git pushes or fetches.
  await run("git", [
    "config",
    "--file",
    config,
    `url.${pathToFileURL(remote).href}.insteadOf`,
    "https://github.com/octo/ace.git",
  ]);
  const before = local(reviewed, trunk);
  const gh = await fakeGh({
    ...host(reviewed),
    "stack-view": [{ body: before }],
    "stack-rebase": [{ code: 0 }],
    "repos/octo/ace/pulls/8": [{ offline: true }],
  });
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(checkout, "Project");
  const thread = Thread.parse({
    id: "stack-thread",
    workspaceId,
    provider: "codex",
    title: "Stack task",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, checkout, () => 1000, {
    forgeRunner: () => (request) => gh.runner({ ...request, command: gh.executable }),
    git: {
      transportProtocols: ["file"],
      processRuntime: {
        spawn(command, args, options) {
          const lost = lostAcknowledgement && args.includes("push");
          const wrapped = lost
            ? ["-c", `"$0" "$@" >/dev/null 2>&1; exit 128`, command, ...args]
            : args;
          return spawnGitProcess(lost ? "/bin/sh" : command, wrapped, {
            ...options,
            env: {
              ...options.env,
              ...(args.includes("push") || args.includes("fetch")
                ? { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" }
                : {}),
            },
          });
        },
      },
    },
  });
  await runtime.forge.link(thread.id, checkout, { repository, number: 8 });
  const layersOf = (heads: Heads) =>
    names.map((name, index) => ({ number: 7 + index, headSha: heads[name] }));
  return {
    gh,
    checkout,
    remote,
    trunk,
    reviewed,
    /** Simulate gh stack's local rebase onto a new trunk commit. */
    async rebaseLocally(files: LayerFiles = {}) {
      await git(checkout, "switch", "-q", "main");
      await git(checkout, "commit", "-q", "--allow-empty", "-m", "Trunk moved");
      const moved = await git(checkout, "rev-parse", "HEAD");
      const rebased = await layers(checkout, moved, "rebased", files);
      await gh.replace({ ...host(reviewed), "stack-view": [{ body: local(rebased, moved) }] });
      return { rebased, after: local(rebased, moved), trunk: moved };
    },
    command(id: string, action: ForgeStackOperation["action"], expected: ForgeStackExpected) {
      return runtime.execute(
        Command.parse({
          id,
          deviceId: "device",
          payload: {
            type: "forge.pr.stack.change",
            link: { threadId: thread.id, pr: { repository, number: 8 } },
            expected,
            action,
            method: "squash",
          },
        }),
      );
    },
    expected(heads: Heads, stack: ForgeLocalStack): ForgeStackExpected {
      return { id: "STACK_42", trunk: "main", layers: layersOf(heads), local: stack };
    },
    before,
    read() {
      return runtime.read(
        WorkspaceActionRequest.parse({
          type: "workspace.request",
          requestId: "stack",
          operation: {
            op: "forge.pr.stack",
            workspaceId,
            repository,
            number: 8,
            threadId: thread.id,
          },
        }),
      );
    },
    async published() {
      return Promise.all(names.map((name) => git(remote, "rev-parse", `refs/heads/${name}`)));
    },
    async close() {
      await runtime.close();
      await store.close();
      await gh.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}
