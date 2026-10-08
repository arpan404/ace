import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawnGitProcess } from "@ace/git";
import { createCommandRunner } from "@ace/forge";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { Capabilities, DeviceId } from "@ace/protocol";
import { AdapterRegistry, readConfig, startDaemon } from "./index.ts";
import { Client } from "./socket-test-support.ts";
import { command, git } from "./thread-creation-test-support.ts";

/** Production composition with no provider CLI or real forge at any boundary. */
export async function reviewPrFixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-review-pr-")));
  const repo = join(home, "repo");
  await mkdir(repo);
  const runGit = (...args: string[]) => git("git", ["-C", repo, ...args]);
  await runGit("init", "-q", "-b", "main");
  await runGit("config", "user.name", "Review fixture");
  await runGit("config", "user.email", "review@example.invalid");
  await writeFile(join(repo, "file.ts"), "before\noriginal\nafter\n");
  await runGit("add", ".");
  await runGit("commit", "-qm", "Initial");
  await runGit("remote", "add", "origin", "https://github.com/octo/ace.git");
  const registry = new AdapterRegistry();
  registry.register(
    createScriptedAdapter({
      provider: "codex",
      capabilities: Capabilities.parse({
        steer: true,
        interruptCascades: false,
        resume: true,
        fork: false,
        subagentTranscripts: true,
        backgroundTaskControl: true,
        backgroundVisibility: "full",
        planMode: true,
        tokenUsage: true,
        imageInput: true,
        rewindFiles: false,
      }),
      steps: [],
      createTranslator: () => ({ translate: () => [], tick: () => [] }),
    }),
    {
      installed: true,
      path: join(home, "unused-provider"),
      version: "fake",
      auth: "logged_in",
      loginHint: "synthetic",
    },
  );
  const gh = join(home, "gh");
  const state = join(home, "forge.json");
  await writeFile(state, JSON.stringify({ code: 200, merged: false, ci: "pending" }));
  await writeFile(
    gh,
    `#!${process.execPath}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const file = ${JSON.stringify(state)};
const state = JSON.parse(readFileSync(file,'utf8'));
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(home, "gh-calls"))}, JSON.stringify(args)+'\\n');
if(state.code==='cli') process.exit(1);
const path=args[1];
if(args[0]==='pr') process.exit(0);
let input=''; for await(const chunk of process.stdin) input+=chunk;
const pr={number:42,node_id:'PR_42',title:'Existing review PR',html_url:'https://github.com/octo/ace/pull/42',state:state.merged?'closed':'open',draft:false,merged:state.merged,mergeable:true,head:{sha:'${"a".repeat(40)}',ref:state.branch},base:{ref:'main'}};
let body=[];
if(path.startsWith('repos/octo/ace/pulls?')) body=[pr];
else if(path==='repos/octo/ace/pulls/42') body=pr;
else if(path.endsWith('/merge')) {state.merged=true;writeFileSync(file,JSON.stringify(state));body={merged:true};}
else if(path.endsWith('/requested_reviewers')) body={requested_reviewers:[{login:'reviewer'}]};
else if(path.endsWith('/replies')) body={id:9};
else if(path.includes('/check-runs?')) body={check_runs:[{id:1,name:'test',status:state.ci==='success'?'completed':'in_progress',conclusion:state.ci==='success'?'success':null,completed_at:null}]};
else if(path==='graphql') body={data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[]}}}}};
if(state.code!==200) body={message:'fixture refusal'};
process.stdout.write('HTTP/1.1 '+state.code+' Fixture\\r\\n\\r\\n'+JSON.stringify(body));
`,
    { mode: 0o700 },
  );
  let gitFailure = "";
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: join(home, "daemon"), ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    engine: { registry },
    modelInstances: [],
    toolkits: [],
    notificationChannels: {},
    workspaceActions: {
      git: {
        processRuntime: {
          spawn(binary, args, options) {
            if (gitFailure && (args.includes("commit") || args.includes("push")))
              return spawnGitProcess(
                process.execPath,
                ["-e", `process.stderr.write(${JSON.stringify(gitFailure)});process.exit(1)`],
                options,
              );
            return spawnGitProcess(binary, args, options);
          },
        },
      },
      forgeRunner: (cwd) => {
        const runner = createCommandRunner({ cwd, env: { HOME: home, PATH: home } });
        return (request) => runner({ ...request, command: gh });
      },
    },
  });
  const client = new Client(daemon.url);
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("device"),
    token: (await readFile(daemon.tokenPath, "utf8")).trim(),
  });
  await client.next();
  const workspaceId = daemon.store.createWorkspace(repo, "Scratch review");
  let serial = 0;
  const send = (payload: Parameters<typeof command>[2], id = `loop-${++serial}`) =>
    command(client, id, payload);
  return {
    home,
    repo,
    runGit,
    daemon,
    client,
    workspaceId,
    send,
    failGit(message: string) {
      gitFailure = message;
    },
    async forgeState(patch: Record<string, unknown>) {
      const current: unknown = JSON.parse(await readFile(state, "utf8"));
      if (typeof current !== "object" || current === null) throw new Error("Invalid fixture state");
      await writeFile(state, JSON.stringify({ ...current, ...patch }));
    },
    async close() {
      await client.close();
      await daemon.close();
      await registry.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
