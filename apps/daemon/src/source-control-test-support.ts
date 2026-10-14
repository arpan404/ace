import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Thread, ThreadId } from "@ace/protocol";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { createWritingCli } from "./source-control-cli.ts";
import { createUtilityCli } from "./utility-cli.ts";
import { UtilityModels } from "./utility-models.ts";
import { readyStatus } from "./utility-test-support.ts";
import type { EngineClock } from "./engine/actor.ts";

export const writingThreadId = ThreadId.parse("writing-thread");
export async function writingFixture(
  provider: "claude" | "codex" = "claude",
  behavior = "success",
  writing: { clock?: EngineClock } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ace-writing-test-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(join(repo, "selected.txt"), "before\n");
  await writeFile(join(repo, "excluded.txt"), "private before\n");
  await writeFile(join(repo, "AGENTS.md"), "Use imperative subjects and explain intent.\n");
  git("add", ".");
  git("commit", "-m", "fix: initial behavior");
  const initialHead = git("rev-parse", "HEAD");
  git("switch", "-c", "feature");
  await writeFile(join(repo, "selected.txt"), "after selected\n");
  await writeFile(join(repo, "excluded.txt"), "private excluded change\n");
  git("add", "excluded.txt");
  const cli = join(root, "provider.mjs");
  await writeFile(
    cli,
    `#!/usr/bin/env node
import fs from 'node:fs';
let prompt=''; for await (const bytes of process.stdin) prompt+=bytes;
fs.writeFileSync(${JSON.stringify(join(root, "prompt.txt"))}, prompt);
fs.writeFileSync(${JSON.stringify(join(root, "args.json"))}, JSON.stringify(process.argv.slice(2)));
if (${JSON.stringify(behavior)} === 'overflow') { process.stdout.write(Buffer.alloc(1_048_577, 'x')); setInterval(()=>{},1000); await new Promise(()=>{}); }
if (${JSON.stringify(behavior)} === 'hold') await new Promise(resolve => { const watcher=fs.watch(${JSON.stringify(root)},()=>{ if(fs.existsSync(${JSON.stringify(join(root, "release"))})) {watcher.close();resolve();} }); if(fs.existsSync(${JSON.stringify(join(root, "release"))})) {watcher.close();resolve();} });
if (${JSON.stringify(behavior)} === 'wait') { setInterval(()=>{},1000); await new Promise(()=>{}); }
if (${JSON.stringify(behavior)} === 'move') fs.writeFileSync(${JSON.stringify(join(repo, "selected.txt"))}, 'changed while generating\\n');
if (${JSON.stringify(behavior)} === 'fail') { console.error('Authorization: Bearer private-diagnostic'); process.exit(1); }
const draft = JSON.stringify({subject:'fix: update selected behavior',body:'Explain the selected change.'});
if (${JSON.stringify(behavior)} === 'invalid') console.log(JSON.stringify({result:'not valid JSON'}));
else if (${JSON.stringify(provider)} === 'claude') console.log(JSON.stringify({result:draft}));
else { console.log(JSON.stringify({type:'unknown.future',item:'future-shape',other:{retained:true}})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:draft}})); console.log(JSON.stringify({type:'turn.completed'})); }
`,
  );
  await chmod(cli, 0o700);
  const store = new Store(join(root, "store.sqlite"));
  const workspaceId = store.createWorkspace(repo, "Repo");
  const thread = Thread.parse({
    id: writingThreadId,
    workspaceId,
    title: "Explain selected behavior",
    provider,
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(writingThreadId, [{ type: "thread.created", thread }]);
  const utility = new UtilityModels({
    choice: async () => ({ provider, model: "test-model" }),
    statuses: () => [readyStatus(provider)],
    models: () => [],
    run: createUtilityCli({
      ...writing,
      locate: async () => ({ path: cli, env: {} }),
      tempRoot: root,
    }),
  });
  const runtime = new WorkspaceRuntime(store, root, () => 1, {
    writingCli: createWritingCli({
      generate: (prompt, signal, limits) => utility.generate(prompt, signal, limits),
    }),
  });
  const selection = { kind: "commit" as const, paths: ["selected.txt"] };
  const context = () => runtime.draftContext(writingThreadId, selection);
  const generate = async (signal?: AbortSignal) =>
    runtime.read(
      {
        type: "workspace.request",
        requestId: "generate",
        operation: {
          op: "git.draft.generate",
          threadId: writingThreadId,
          input: {
            generationId: "generation",
            selection,
            fingerprint: (await context()).fingerprint,
            preference: "Use conventional commits",
          },
        },
      },
      signal,
    );
  return {
    root,
    repo,
    cli,
    workspaceId,
    store,
    runtime,
    git,
    initialHead,
    selection,
    context,
    generate,
    close: async () => {
      await runtime.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
