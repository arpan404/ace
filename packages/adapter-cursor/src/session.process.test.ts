import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { apply, createThreadState } from "@ace/core";
import { createCursorAdapter, openCursorSession, CursorHost } from "./index.ts";

const fakeHost = `
import { createInterface } from 'node:readline';
let options, sending, run=0;
const out = (input) => process.stdout.write(JSON.stringify(input)+'\\n');
const frame = (kind, body) => out({method:'frame',params:{schemaVersion:1,generation:options.generation,operationId:sending?.operationId??'open',segment:sending?.segment??0,agentId:'synthetic-agent',runId:'run-'+run,kind,body}});
createInterface({input:process.stdin}).on('line',(line)=>{
 const input=JSON.parse(line);
 if(input.method==='open'){options=input.params;frame('open',{cwd:options.cwd});out({id:input.id,result:{agentId:'synthetic-agent'}});}
 else if(input.method==='send'){sending=input.params;run++;frame('send',{input:sending.input});frame('segment',{nativeRunId:'run-'+run});frame('delta',{type:'text-delta',text:'segment-'+run});if(sending.input[0]?.text==='uncertain')frame('result',{status:'future-status'});out({id:input.id,result:{runId:'run-'+run}});}
 else if(input.method==='cancel'){frame('result',{status:'cancelled'});out({id:input.id,result:{settled:true}});}
 else if(input.method==='close'){frame('result',{status:'finished'});out({id:input.id,result:{disposed:true}});}
});
`;
it("supervises a real host, keeps steering in one ace run and rejects child controls", async () => {
  const home = await mkdtemp(join(tmpdir(), "cursor-host-"));
  try {
    const entry = join(home, "host.mjs");
    await writeFile(entry, fakeHost);
    const threadId = ThreadId.parse("session-test");
    const translator = createCursorAdapter().createTranslator({ threadId, rootKey: "root" });
    const state = createThreadState({ threadId, config: { provider: "cursor", silenceMs: 90000 } });
    let id = 0;
    let exit: { deliberate: boolean } | undefined;
    let pinnedNative: string | undefined;
    const session = await openCursorSession(
      {
        threadId,
        cwd: home,
        signal: new AbortController().signal,
        onSessionIdentity: (identity) => {
          pinnedNative = identity.nativeSessionId;
        },
        onExit: (value) => {
          exit = value;
        },
        onFrame: (frame) => {
          expect(pinnedNative).toBe("synthetic-agent");
          for (const fact of translator.translate(frame, frame.t))
            apply(state, fact, { now: frame.t, ids: { next: (kind) => `${kind}-${++id}` } });
        },
      },
      {
        env: { HOME: home },
        instanceId: "instance",
        entry,
        policy: "full-access",
        generation: () => "host1",
        now: () => 1,
      },
    );
    await session.send([{ type: "text", text: "first" }], "queue", "durable-command-1");
    await session.send([{ type: "text", text: "replacement" }], "steer", "durable-command-2");
    expect(Object.values(state.runs)).toHaveLength(1);
    await expect(session.interrupt({ agent: "child", cascade: true })).rejects.toThrow("read-only");
    await expect(session.stopTask("task")).rejects.toThrow("unsupported");
    await expect(
      session.resolve("question", { kind: "question", answers: {}, dismissed: true }),
    ).rejects.toThrow("sandbox-only");
    await session.send([{ type: "text", text: "uncertain" }], "steer", "durable-command-3");
    await expect(
      session.send([{ type: "text", text: "must not dispatch" }], "queue"),
    ).rejects.toThrow("uncertain");
    expect(Object.values(state.runs)).toHaveLength(1);
    await session.interrupt({ cascade: true });
    await expect(session.send([{ type: "text", text: "after stop" }], "queue")).rejects.toThrow(
      "closed",
    );
    await session.close("shutdown");
    expect(exit).toEqual({ deliberate: true });
    expect(Object.values(state.runs)).toHaveLength(1);
    expect(JSON.stringify(state.items)).toContain("durable-command-1");
    expect(session.backend).toBe("cursor-sdk");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("waits for the engine's durable frame acknowledgement across independent host round trips", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-frame-ack-"));
  const received = Promise.withResolvers<void>(),
    commit = Promise.withResolvers<void>();
  const entry = join(root, "ack.mjs");
  await writeFile(
    entry,
    `
import {createInterface} from 'node:readline';
let options, pending, acknowledged=false;
const out=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const input=JSON.parse(line);
 if(input.method==='open') { options=input.params;out({id:input.id,result:{agentId:'native'}}); }
 else if(input.method==='send') { pending=input.id;out({id:'host:1',method:'frame',params:{schemaVersion:1,generation:options.generation,operationId:'intent',segment:0,kind:'delta',body:{type:'text-delta',text:'await storage'}}}); }
 else if(input.id==='host:1') { if(input.error)process.exit(1);acknowledged=true;out({id:pending,result:{runId:'native-run'}}); }
 else if(input.method==='probe') out({id:input.id,result:{acknowledged}});
});
`,
  );
  const host = new CursorHost(
    { env: { HOME: root }, entry, generation: () => "host" },
    async () => {
      received.resolve();
      await commit.promise;
    },
  );
  try {
    await host.request("open", { generation: host.generation });
    const sending = host.request("send");
    await received.promise;
    // The first round trip drains ACK-producing parent microtasks. The second
    // crosses the child's FIFO input after any prematurely queued ACK. Both
    // happen with storage blocked; no immediate promise-state/timing assertion.
    await host.request("probe");
    expect(await host.request("probe")).toEqual({ acknowledged: false });
    commit.resolve();
    expect(await sending).toEqual({ runId: "native-run" });
    expect(await host.request("probe")).toEqual({ acknowledged: true });
  } finally {
    commit.resolve();
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});
