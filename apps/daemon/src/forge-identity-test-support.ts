import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { SettingsService } from "@ace/settings";
import { createCommandRunner } from "@ace/forge";
import { Thread } from "@ace/protocol";
import { Store } from "./store.ts";
import { SourceControl } from "./source-control.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const stateSchema = z.object({
  account: z.string(), replies: z.array(z.object({ id: z.number(), body: z.string(), user: z.object({ login: z.string() }), in_reply_to_id: z.number() })),
  switchAfterReply: z.boolean(), holdPath: z.string(), users: z.number(), holdUser: z.number(),
});
const script = `#!${process.execPath}
import { readFileSync,writeFileSync,existsSync,watch } from 'node:fs';
const dir=process.env.ACE_FORGE_FIXTURE, file=dir+'/state.json', args=process.argv.slice(2), path=args[1];
let f=JSON.parse(readFileSync(file,'utf8'));
function save(){writeFileSync(file,JSON.stringify(f))}
function http(body){console.log('HTTP/1.1 200 OK\\n\\n'+JSON.stringify(body))}
async function hold(){writeFileSync(dir+'/held','held'); await new Promise(resolve=>{const w=watch(dir,()=>{if(existsSync(dir+'/release')){w.close();resolve()}});if(existsSync(dir+'/release')){w.close();resolve()}})}
if(path==='user') { f.users++; save(); if(f.users===f.holdUser) await hold(); console.log(JSON.stringify({login:f.account})); }
else {
 if(f.holdPath===path) await hold();
 const pr={number:7,node_id:'PR_7',title:'Selected repository',html_url:'https://git.example.com/octo/ace/pull/7',state:'open',head:{sha:'a'.repeat(40),ref:'topic'},base:{ref:'main'}};
 if(path.endsWith('/replies')) {
   let input=''; for await(const chunk of process.stdin) input+=chunk;
   const body=JSON.parse(input).body;
   f=JSON.parse(readFileSync(file,'utf8')); const reply={id:31+f.replies.length,body,user:{login:f.account},in_reply_to_id:13}; f.replies.push(reply);
   if(f.switchAfterReply) f.account='other'; save(); http(reply);
 } else if(path.includes('/comments?')) http(f.replies);
 else if(path.includes('/pulls?')) http([]);
 else if(path.endsWith('/pulls') || path.endsWith('/pulls/7')) http(pr);
 else if(path.includes('/check-runs?')) http({check_runs:[]});
 else if(path==='graphql') http({data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[]}}}}});
 else http([]);
}
`;
export async function forgeIdentityFixture() {
  const root = await mkdtemp(join(tmpdir(), "ace-forge-identity-"));
  const execute = promisify(execFile);
  await execute("git", ["init", "-q", "-b", "main", root]);
  await execute("git", ["-C", root, "remote", "add", "origin", "https://github.com/fork/ace.git"]);
  await execute("git", ["-C", root, "remote", "add", "upstream", "git@git.example.com:octo/ace.git"]);
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "gh"), script, { mode: 0o755 });
  const state = join(root, "state.json");
  await writeFile(state, JSON.stringify({ account: "octo", replies: [], switchAfterReply: false, holdPath: "", users: 0, holdUser: 0 }));
  const runner = () => createCommandRunner({ cwd: root, env: { PATH: root, ACE_FORGE_FIXTURE: root } });
  const settings = new SettingsService({ dataDir: root });
  const preferences = { hosts: [{ host: "github.com", account: "octo" }, { host: "git.example.com", account: "octo" }], host: "git.example.com", remote: "upstream" };
  await settings.set("sourceControl.preferences", preferences, { kind: "global" });
  const sourceControl = new SourceControl(settings, runner, root);
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const thread = Thread.parse({ id: "identity-thread", workspaceId, provider: "codex", title: "Identity", status: { state: "new" }, createdAt: 1, updatedAt: 1 });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, root, () => 1000, { sourceControl, forgeRunner: runner });
  const facts = async () => stateSchema.parse(JSON.parse(await readFile(state, "utf8")));
  return {
    root, settings, sourceControl, store, thread, runtime, preferences, facts,
    async update(value: Partial<z.infer<typeof stateSchema>>) { await writeFile(state, JSON.stringify({ ...await facts(), ...value })); },
    held() {
      return new Promise<void>((resolve, reject) => {
        const watcher = watch(root, check);
        function check() { void readFile(join(root, "held"), "utf8").then(() => { watcher.close(); resolve(); }, (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") { watcher.close(); reject(error); } }); }
        check();
      });
    },
    release: () => writeFile(join(root, "release"), "release"),
    async close() { await runtime.close(); await settings.close(); await store.close(); await rm(root, { recursive: true, force: true }); },
  };
}
