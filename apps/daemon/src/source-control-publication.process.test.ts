import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { createCommandRunner } from "@ace/forge";
import { Command, Thread, ThreadId } from "@ace/protocol";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const threadId = ThreadId.parse("publication-thread");
const repository = { forge: "github", host: "github.com", owner: "acme", name: "repo" } as const;
const executeFile = promisify(execFile);

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ace-draft-publication-"));
  const repo = join(home, "repo");
  const remote = join(home, "remote.git");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "--bare", remote);
  git("init", "-b", "main");
  git("config", "user.name", "Publication fixture");
  git("config", "user.email", "test@example.invalid");
  await writeFile(join(repo, "file.txt"), "before\n");
  git("add", ".");
  git("commit", "-m", "Initial");
  const base = git("rev-parse", "HEAD");
  git("remote", "add", "origin", "https://github.com/acme/repo.git");
  git("remote", "set-url", "--push", "origin", remote);
  git("push", "origin", "main");
  git("push", "origin", "main:release");
  git("update-ref", "refs/remotes/origin/release", base);
  git("switch", "-c", "feature");
  await writeFile(join(repo, "file.txt"), "reviewed change\n");
  git("add", ".");
  git("commit", "-m", "Reviewed change");
  git("push", "--set-upstream", "origin", "feature");
  // A local namesake points at the feature head and must not become the comparison base.
  git("branch", "release", "feature");
  const cli = join(home, "gh.mjs");
  await writeFile(
    cli,
    `#!${process.execPath}
import {existsSync, watch, writeFileSync, readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const home = ${JSON.stringify(home)};
const remote = ${JSON.stringify(remote)};
async function hold(name) {
  if(!existsSync(home+'/'+name+'.hold')) return;
  await new Promise(resolve => {
    const done = () => { if(existsSync(home+'/'+name+'.release')) { watcher.close(); resolve(); } };
    const watcher = watch(home, done);
    writeFileSync(home+'/'+name+'.started','');
    done();
  });
}
const args=process.argv.slice(2); const path=args[1];
let input=''; for await(const chunk of process.stdin) input+=chunk;
let body=[];
if(path.startsWith('repos/acme/repo/pulls?')) await hold('lookup');
else if(path==='repos/acme/repo/pulls') {
  await hold('create');
  if(existsSync(home+'/create.fail')) { process.stdout.write('HTTP/1.1 403 Forbidden\\r\\n\\r\\n{}'); process.exit(0); }
  const fields=JSON.parse(input);
  const head=execFileSync('git',['--git-dir',remote,'rev-parse','refs/heads/feature'],{encoding:'utf8'}).trim();
  writeFileSync(home+'/created.json',JSON.stringify({...fields,head}));
  body={number:1,node_id:'PR_1',title:fields.title,html_url:'https://github.com/acme/repo/pull/1',state:'open',draft:false,head:{ref:'feature',sha:head},base:{ref:fields.base}};
  writeFileSync(home+'/pr.json',JSON.stringify(body));
} else if(path==='repos/acme/repo/pulls/1') body=JSON.parse(readFileSync(home+'/pr.json','utf8'));
else if(path.includes('/check-runs?')) body={check_runs:[]};
else if(path==='graphql') body={data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[]}}}}};
process.stdout.write('HTTP/1.1 200 OK\\r\\n\\r\\n'+JSON.stringify(body));
`,
    { mode: 0o700 },
  );
  const store = new Store(join(home, "store.sqlite"));
  const workspaceId = store.createWorkspace(repo, "Repo");
  store.appendEvents(threadId, [
    {
      type: "thread.created",
      thread: Thread.parse({
        id: threadId,
        workspaceId,
        title: "Reviewed PR",
        provider: "codex",
        status: { state: "new" },
        createdAt: 1,
        updatedAt: 1,
      }),
    },
  ]);
  const runtime = new WorkspaceRuntime(store, home, () => 1, {
    forgeRunner: (cwd) => {
      const run = createCommandRunner({ cwd, timeoutMs: 60000 });
      return (request) => run({ ...request, command: cli });
    },
  });
  const selection = {
    kind: "pr" as const,
    branch: "feature",
    base: "release",
    baseRef: "refs/remotes/origin/release",
  };
  const context = await runtime.draftContext(threadId, selection);
  const publish = (
    comparison = selection,
    fingerprint = context.fingerprint,
    commandId = "publish",
  ) =>
    runtime.execute(
      Command.parse({
        id: commandId,
        deviceId: "test",
        payload: {
          type: "forge.pr.create",
          threadId,
          repository,
          draftFingerprint: fingerprint,
          draftBaseRef: comparison.baseRef,
          input: {
            branch: "feature",
            base: comparison.base,
            title: "Reviewed title",
            summary: "Reviewed summary",
            template: { title: "{{title}}", body: "{{summary}}" },
            draft: false,
          },
        },
      }),
    );
  const commit = () =>
    runtime.execute(
      Command.parse({
        id: "commit",
        deviceId: "test",
        payload: {
          type: "git.commit",
          threadId,
          paths: ["file.txt"],
          message: "Later change",
          expectedHead: context.head,
        },
      }),
    );
  const push = () =>
    runtime.execute(
      Command.parse({
        id: "push",
        deviceId: "test",
        payload: { type: "git.push", threadId, remote: "origin" },
      }),
    );
  const hold = (name: string) => writeFile(join(home, `${name}.hold`), "");
  const release = (name: string) => writeFile(join(home, `${name}.release`), "");
  const started = (name: string) =>
    new Promise<void>((resolve) => {
      const path = join(home, `${name}.started`);
      const watcher = watch(home, () => {
        if (existsSync(path)) {
          watcher.close();
          resolve();
        }
      });
      if (existsSync(path)) {
        watcher.close();
        resolve();
      }
    });
  return {
    home,
    repo,
    git,
    runtime,
    store,
    context,
    publish,
    commit,
    push,
    hold,
    release,
    started,
    async close() {
      await release("lookup");
      await release("create");
      await runtime.close();
      await store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("a divergent upstream base cannot publish a reviewed draft to the origin fork", async () => {
  const f = await fixture();
  try {
    f.git("remote", "add", "upstream", "https://github.com/acme/upstream.git");
    f.git("switch", "main");
    await writeFile(join(f.repo, "upstream.txt"), "Upstream change X\n");
    f.git("add", "upstream.txt");
    f.git("commit", "-m", "Upstream change X");
    f.git("update-ref", "refs/remotes/upstream/main", "HEAD");
    f.git("switch", "feature");
    f.git("rebase", "main");
    f.git("push", "--force", "origin", "feature");
    expect(f.git("diff", "--name-only", "upstream/main...feature")).toBe("file.txt");
    expect(f.git("diff", "--name-only", "origin/main...feature")).toBe("file.txt\nupstream.txt");
    const upstream = {
      kind: "pr" as const,
      branch: "feature",
      base: "main",
      baseRef: "refs/remotes/upstream/main",
    };
    // Obtain a real reviewed fingerprint with upstream as the publication destination.
    // Restoring the fork must refuse that draft even though its branch/base revisions match.
    const originMain = f.git("rev-parse", "origin/main");
    const pushUrl = f.git("config", "--get", "remote.origin.pushurl");
    f.git("remote", "remove", "origin");
    const reviewed = await f.runtime.draftContext(threadId, upstream);
    expect(reviewed.paths).toEqual(["file.txt"]);
    f.git("remote", "add", "origin", "https://github.com/acme/repo.git");
    f.git("remote", "set-url", "--push", "origin", pushUrl);
    f.git("update-ref", "refs/remotes/origin/main", originMain);
    expect(await f.publish(upstream, reviewed.fingerprint)).toMatchObject({
      ok: false,
      error: "git_pr_base_mismatch",
    });
    expect(existsSync(join(f.home, "created.json"))).toBe(false);
    expect(f.store.getThread(threadId)?.details?.linkedPrs ?? []).toEqual([]);
    // A fresh draft against the actual destination can still be published.
    const comparison = {
      kind: "pr" as const,
      branch: "feature",
      base: "main",
      baseRef: "refs/remotes/origin/main",
    };
    const context = await f.runtime.draftContext(threadId, comparison);
    expect(context.paths).toEqual(["file.txt", "upstream.txt"]);
    expect(await f.publish(comparison, context.fingerprint, "publish-origin")).toMatchObject({
      ok: true,
    });
    expect(
      z
        .object({ base: z.string(), head: z.string() })
        .parse(JSON.parse(await readFile(join(f.home, "created.json"), "utf8"))),
    ).toEqual({ base: "main", head: context.head });
  } finally {
    await f.close();
  }
}, 60000);

test("changing the publication destination during lookup invalidates the draft", async () => {
  const f = await fixture();
  try {
    await f.hold("lookup");
    const publication = f.publish();
    await f.started("lookup");
    f.git("remote", "set-url", "origin", "https://github.com/acme/other-fork.git");
    await f.release("lookup");
    expect(await publication).toMatchObject({ ok: false, error: "git_head_moved" });
    expect(existsSync(join(f.home, "created.json"))).toBe(false);
  } finally {
    await f.close();
  }
}, 60000);

test("source changes committed and pushed during PR lookup refuse the reviewed summary", async () => {
  const f = await fixture();
  try {
    await f.hold("lookup");
    const publication = f.publish();
    await f.started("lookup");
    await writeFile(join(f.repo, "file.txt"), "new unseen change\n");
    expect(await f.commit()).toMatchObject({ ok: true });
    expect(await f.push()).toMatchObject({ ok: true });
    await f.release("lookup");
    expect(await publication).toMatchObject({ ok: false, error: "git_head_moved" });
    expect(existsSync(join(f.home, "created.json"))).toBe(false);
    expect(f.store.getThread(threadId)?.details?.linkedPrs ?? []).toEqual([]);
  } finally {
    await f.close();
  }
}, 60000);

test("a moved remote base is rechecked after PR lookup before creation", async () => {
  const f = await fixture();
  try {
    await f.hold("lookup");
    const publication = f.publish();
    await f.started("lookup");
    f.git("update-ref", "refs/remotes/origin/release", "feature");
    await f.release("lookup");
    expect(await publication).toMatchObject({ ok: false, error: "git_invalid_argument" });
    expect(existsSync(join(f.home, "created.json"))).toBe(false);
  } finally {
    await f.close();
  }
}, 60000);

test("PR creation holds the checkout mutation lease until publication settles", async () => {
  const f = await fixture();
  try {
    await f.hold("create");
    const publication = f.publish();
    await f.started("create");
    await writeFile(join(f.repo, "file.txt"), "later daemon change\n");
    const mutation = f.commit().then(async (result) => {
      expect(result.ok).toBe(true);
      expect(await f.push()).toMatchObject({ ok: true });
    });
    // An independent public GitService observes the durable lease while gh is still pending.
    // Without the publication lease it can mutate this checkout; no timing/sleep probe is needed.
    const attempt = await executeFile(process.execPath, [
      "--input-type=module",
      "-e",
      `
import {GitService} from ${JSON.stringify(import.meta.resolve("@ace/git"))};
const git = new GitService();
try { await git.commit({worktree:${JSON.stringify(f.repo)},message:'Unreviewed writer',paths:['file.txt'],expectedHead:${JSON.stringify(f.context.head)}}); console.log(JSON.stringify({code:'committed'})); }
catch(error) { console.log(JSON.stringify({code:error.code})); }
finally { await git.close(); }
`,
    ]);
    expect(z.object({ code: z.string() }).parse(JSON.parse(attempt.stdout))).toEqual({
      code: "git_quarantined",
    });
    expect(f.git("rev-parse", "HEAD")).toBe(f.context.head);
    await f.release("create");
    expect(await publication).toMatchObject({ ok: true, prStatus: { headSha: f.context.head } });
    await mutation;
    expect(
      z
        .object({ head: z.string(), base: z.string(), body: z.string() })
        .parse(JSON.parse(await readFile(join(f.home, "created.json"), "utf8"))),
    ).toEqual({ head: f.context.head, base: "release", body: "Reviewed summary" });
    expect(f.git("rev-parse", "HEAD")).not.toBe(f.context.head);
    expect(f.store.getThread(threadId)?.details?.linkedPrs).toMatchObject([{ number: 1 }]);
  } finally {
    await f.close();
  }
}, 60000);

test("a refused guarded publication retains the forge failure and releases Git mutations", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.home, "create.fail"), "");
    expect(await f.publish()).toMatchObject({ ok: false, error: "forge_forbidden" });
    expect(existsSync(join(f.home, "created.json"))).toBe(false);
    await writeFile(join(f.repo, "file.txt"), "later change\n");
    expect(await f.commit()).toMatchObject({ ok: true });
    expect(f.git("rev-parse", "HEAD")).not.toBe(f.context.head);
  } finally {
    await f.close();
  }
}, 60000);
