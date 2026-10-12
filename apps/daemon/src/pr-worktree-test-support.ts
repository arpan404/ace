import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, ThreadId } from "@ace/protocol";
import {
  fakeGh,
  standard,
  pr,
  repository as hosted,
  threads,
  type Fixtures,
} from "@ace/forge/testing";
import { transitionHarness } from "./engine/transition-test-support.ts";
import { command, connect, git, repository } from "./thread-creation-test-support.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { startServer } from "./server.ts";
import { token } from "./socket-test-support.ts";

export const run = async (cwd: string, ...args: string[]) =>
  (await git("git", ["-C", cwd, ...args])).stdout.trim();

/** Real Git and SQLite/socket edges; only the person's gh executable is substituted. */
export async function prDaemon(
  options: {
    fork?: boolean;
    content?: (root: string, scratch: string) => Promise<void>;
    configureGit?: (root: string) => Promise<void>;
    configure?: (fixtures: Fixtures, value: { head: string; base: string; source: string }) => void;
    matchRepository?: boolean;
  } = {},
) {
  const h = transitionHarness();
  await repository(h.home);
  await h.engine.ready();
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "ace-pr-worktree-")));
  const origin = join(scratch, "origin.git");
  await git("git", ["clone", "--bare", "--", h.home, origin]);
  await run(h.home, "remote", "add", "origin", origin);
  await run(h.home, "config", "user.name", "Test");
  await run(h.home, "config", "user.email", "test@ace.local");
  const base = await run(h.home, "rev-parse", "HEAD");
  await run(h.home, "switch", "-c", "feat/fix");
  await writeFile(join(h.home, "pr.txt"), "PR-only content\n");
  await options.content?.(h.home, scratch);
  await run(h.home, "add", ".");
  await run(h.home, "commit", "-m", "PR work");
  const head = await run(h.home, "rev-parse", "HEAD");
  await run(h.home, "push", "origin", "HEAD:refs/pull/7/head");
  await run(h.home, "switch", "main");
  await options.configureGit?.(h.home);
  await writeFile(join(h.home, "file.txt"), "Personal dirty edit\n");
  const owner = options.fork ? "contributor" : "octo";
  const source = `repos/${owner}/ace/git/ref/heads/feat%2Ffix`;
  const fixtures = standard();
  const rich = {
    ...pr,
    head: { sha: head, ref: "feat/fix", repo: { owner: { login: owner }, name: "ace" } },
    base: { ref: "main", sha: base },
    body: "Please preserve the review context.",
    user: { login: owner },
    labels: [],
    requested_reviewers: [],
    commits: 1,
    changed_files: 1,
  };
  fixtures["repos/octo/ace/pulls/7"] = [{ body: rich }];
  fixtures[source] = [{ body: { object: { sha: head } } }];
  fixtures[`repos/octo/ace/commits/${head}/check-runs?per_page=100&filter=latest`] = [
    { body: { check_runs: [] } },
  ];
  fixtures[`repos/octo/ace/commits/${head}/statuses?per_page=100`] = [{ body: [] }];
  fixtures.graphql = [
    {
      body: {
        data: {
          repository: {
            pullRequest: {
              ...threads().data.repository.pullRequest,
              reviewDecision: null,
              headRefOid: head,
            },
          },
        },
      },
    },
  ];
  options.configure?.(fixtures, { head, base, source });
  const gh = await fakeGh(fixtures);
  const runtimeOptions = {
    git: { transportProtocols: ["file"] as const },
    forgeRunner: () => (request: Parameters<typeof gh.runner>[0]) =>
      gh.runner({ ...request, command: gh.executable }),
    ...(options.matchRepository ? {} : { prRemote: () => "origin" }),
    changeWorkspace: (...args: Parameters<typeof h.engine.changeWorkspace>) =>
      h.engine.changeWorkspace(...args),
    reconcileThread: (id: ThreadId) => h.engine.reconcileThread(id),
  };
  let runtime = new WorkspaceRuntime(h.store, join(scratch, "data"), () => 1000, runtimeOptions);
  const open = () =>
    startServer({
      store: h.store,
      engine: h.engine,
      handler: h.engine.handler,
      workspaceActions: runtime,
      port: 0,
      hostId: "host",
      token,
    });
  let server = await open();
  let client = await connect(server.url);
  const selection = { ref: { repository: hosted, number: 7 }, headSha: head };
  const draft = (id: string) =>
    Command.parse({
      id,
      deviceId: "device",
      payload: {
        type: "thread.create",
        threadId: id,
        workspaceId: h.workspace,
        provider: "codex",
        mode: "worktree",
        pullRequest: selection,
        input: [{ type: "text", text: "My first request" }],
      },
    });
  return {
    h,
    directory: join(scratch, "data"),
    origin,
    head,
    base,
    gh,
    fixtures,
    selection,
    source,
    draft,
    get client() {
      return client;
    },
    get runtime() {
      return runtime;
    },
    create: (id: string) => command(client, id, draft(id).payload),
    work: (id: ThreadId, commandId: string) =>
      command(client, commandId, {
        type: "forge.pr.worktree",
        threadId: id,
        pullRequest: selection,
      }),
    trees: () => run(h.home, "worktree", "list", "--porcelain"),
    async reconnect() {
      await client.close();
      client = await connect(server.url);
    },
    async pauseForCrash() {
      await client.close();
      await server.close();
      await runtime.close();
      await h.engine.close();
    },
    async resumeAfterCrash() {
      await h.reopen();
      runtime = new WorkspaceRuntime(h.store, join(scratch, "data"), () => 1000, runtimeOptions);
      server = await open();
      client = await connect(server.url);
    },
    async reopen() {
      await client.close();
      await server.close();
      await runtime.close();
      await h.reopen();
      runtime = new WorkspaceRuntime(h.store, join(scratch, "data"), () => 1000, runtimeOptions);
      server = await open();
      client = await connect(server.url);
    },
    async close() {
      await client.close();
      await server.close();
      await runtime.close();
      await h.close();
      await gh.cleanup();
      await rm(scratch, { recursive: true, force: true });
    },
  };
}
