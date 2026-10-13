import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { spawnGitProcess } from "@ace/git";
import {
  Command,
  Thread,
  WorkspaceActionRequest,
  type ForgeLocalStack,
  type ForgeStackExpected,
} from "@ace/protocol";
import {
  fakeGh,
  repository,
  stackChecksFixture,
  stackLayers,
  stackResponse,
} from "@ace/forge/testing";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const run = promisify(execFile);
const names = ["model", "api", "ui"] as const;
type Heads = Record<(typeof names)[number], string>;
async function git(cwd: string, ...args: string[]) {
  return (await run("git", ["-C", cwd, ...args])).stdout.trim();
}

/** Commit one layer per branch, each on the layer below it, starting from `base`. */
async function layers(root: string, base: string, label: string): Promise<Heads> {
  const heads: Partial<Heads> = {};
  let parent = base;
  for (const name of names) {
    await git(root, "switch", "-qC", name, parent);
    await git(root, "commit", "-q", "--allow-empty", "-m", `${name} ${label}`);
    parent = heads[name] = await git(root, "rev-parse", "HEAD");
  }
  return { model: heads.model ?? "", api: heads.api ?? "", ui: heads.ui ?? "" };
}

function local(heads: Heads, trunk: string): ForgeLocalStack {
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
function host(heads: Heads) {
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
async function fixture(lostAcknowledgement = false) {
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
  // The bare repository stands in for GitHub only when Git pushes.
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
              ...(args.includes("push")
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
    async rebaseLocally() {
      await git(checkout, "switch", "-q", "main");
      await git(checkout, "commit", "-q", "--allow-empty", "-m", "Trunk moved");
      const moved = await git(checkout, "rev-parse", "HEAD");
      const rebased = await layers(checkout, moved, "rebased");
      await gh.replace({ ...host(reviewed), "stack-view": [{ body: local(rebased, moved) }] });
      return { rebased, after: local(rebased, moved) };
    },
    command(id: string, action: "rebase" | "push", expected: ForgeStackExpected) {
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

test("a rebased stack publishes every moved layer in one leased push and settles as rebased", async () => {
  const f = await fixture();
  try {
    expect(await f.command("rebase", "rebase", f.expected(f.reviewed, f.before))).toMatchObject({
      ok: true,
      stackOperation: { state: "push_partial" },
    });
    const { rebased, after } = await f.rebaseLocally();
    expect(await f.command("publish", "push", f.expected(f.reviewed, after))).toMatchObject({
      ok: true,
      stackOperation: { action: "push", state: "rebased" },
    });
    expect(await f.published()).toEqual([rebased.model, rebased.api, rebased.ui]);
    expect((await f.gh.requests()).some((request) => request.path === "stack-push")).toBe(false);
  } finally {
    await f.close();
  }
});

test("a collaborator commit pushed after review rejects the whole publication and moves no layer", async () => {
  const f = await fixture();
  try {
    await f.command("rebase", "rebase", f.expected(f.reviewed, f.before));
    const { after } = await f.rebaseLocally();
    const collaborator = join(f.remote, "..", "collaborator");
    await run("git", ["clone", "-q", "--branch", "api", f.remote, collaborator]);
    await git(collaborator, "config", "user.name", "Collaborator");
    await git(collaborator, "config", "user.email", "collaborator@example.invalid");
    await git(collaborator, "commit", "-q", "--allow-empty", "-m", "Collaborator fix");
    await git(collaborator, "push", "-q", "origin", "api");
    const theirs = await git(collaborator, "rev-parse", "HEAD");
    expect(await f.command("publish", "push", f.expected(f.reviewed, after))).toMatchObject({
      ok: false,
      stackOperation: { action: "push", state: "failed" },
    });
    expect(await f.published()).toEqual([f.reviewed.model, theirs, f.reviewed.ui]);
    // GitHub now reports the collaborator's head: the refusal names that layer and both heads.
    await f.gh.replace({
      ...host({ ...f.reviewed, api: theirs }),
      "stack-view": [{ body: after }],
    });
    expect(await f.read()).toMatchObject({
      result: {
        kind: "forge",
        data: {
          value: {
            operation: { action: "push", state: "failed" },
            movedLayers: [{ number: 8, branch: "api", reviewed: f.reviewed.api, current: theirs }],
          },
        },
      },
    });
  } finally {
    await f.close();
  }
});

test("a refreshed request carrying a newer GitHub revision cannot replace the reviewed leases", async () => {
  const f = await fixture();
  try {
    await f.command("rebase", "rebase", f.expected(f.reviewed, f.before));
    const { after } = await f.rebaseLocally();
    const moved = { ...f.reviewed, api: "f".repeat(40) };
    await f.gh.replace({ ...host(moved), "stack-view": [{ body: after }] });
    expect(await f.command("publish", "push", f.expected(moved, after))).toMatchObject({
      ok: false,
      error: "forge_conflict",
    });
    expect(await f.published()).toEqual([f.reviewed.model, f.reviewed.api, f.reviewed.ui]);
    expect(await f.read()).toMatchObject({
      result: {
        kind: "forge",
        data: {
          value: {
            operation: { action: "rebase", state: "push_partial" },
            movedLayers: [
              { number: 8, branch: "api", reviewed: f.reviewed.api, current: "f".repeat(40) },
            ],
          },
        },
      },
    });
  } finally {
    await f.close();
  }
});

test("a push whose result Git never reported settles from GitHub's heads instead of being repeated", async () => {
  const f = await fixture(true);
  try {
    await f.command("rebase", "rebase", f.expected(f.reviewed, f.before));
    const { rebased, after } = await f.rebaseLocally();
    expect(await f.command("publish", "push", f.expected(f.reviewed, after))).toMatchObject({
      stackOperation: { action: "push", state: "uncertain" },
    });
    expect(await f.published()).toEqual([rebased.model, rebased.api, rebased.ui]);
    await f.gh.replace({ ...host(rebased), "stack-view": [{ body: after }] });
    expect(await f.read()).toMatchObject({
      result: {
        kind: "forge",
        data: { value: { operation: { action: "push", state: "rebased" } } },
      },
    });
  } finally {
    await f.close();
  }
});
