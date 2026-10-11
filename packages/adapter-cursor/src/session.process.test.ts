import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { apply, createThreadState } from "@ace/core";
import { createCursorAdapter, openCursorSession, CursorEnvelopeSchema } from "./index.ts";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";

const fakeHost = `
import { createInterface } from 'node:readline';
let options, sending, run=0;
const out = (input) => process.stdout.write(JSON.stringify(input)+'\\n');
const frame = (kind, body) => out({method:'frame',params:{schemaVersion:1,generation:options.generation,operationId:sending?.operationId??'open',commandId:sending?.commandId,segment:sending?.segment??0,agentId:'synthetic-agent',runId:'run-'+run,kind,body}});
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
    const inputMessages = new Map<string, string>();
    const session = await openCursorSession(
      {
        threadId,
        cwd: home,
        signal: new AbortController().signal,
        onSessionIdentity: (identity) => {
          pinnedNative = identity.nativeSessionId;
        },
        onInputMessage: (identity) => {
          inputMessages.set(identity.commandId, identity.nativeId);
        },
        onExit: (value) => {
          exit = value;
        },
        onFrame: (frame) => {
          expect(pinnedNative).toBe("synthetic-agent");
          const event = CursorEnvelopeSchema.parse(frame.data);
          if (event.kind === "send" && event.commandId)
            expect(inputMessages.get(event.commandId)).toBe(event.commandId);
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
    expect(Object.values(state.items)).toContainEqual(
      expect.objectContaining({ type: "message", role: "user", nativeId: "durable-command-1" }),
    );
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
 else if(input.method==='close') out({id:input.id,result:{disposed:true}});
});
`,
  );
  let process: SupervisedProcess | undefined;
  let probe: JsonRpcPeer | undefined;
  const session = await openCursorSession(
    {
      threadId: ThreadId.parse("ack-thread"),
      cwd: root,
      signal: new AbortController().signal,
      onExit: () => {},
      onFrame: async (frame) => {
        if (frame.dir === "recv") {
          received.resolve();
          await commit.promise;
        }
      },
    },
    {
      env: { HOME: root },
      entry,
      instanceId: "instance",
      policy: "full-access",
      generation: () => "host",
      now: () => 1,
      spawn: (options) => {
        process = spawnSupervised(options);
        return process;
      },
    },
  );
  try {
    const sending = session.send([{ type: "text", text: "synthetic" }], "queue", "intent");
    await received.promise;
    if (!process) throw new Error("Synthetic host unavailable");
    // Attach the independent peer after the sole frame request was delivered.
    // provider-kit's shared pipe owner reserves distinct request identities.
    probe = new JsonRpcPeer(process);
    // The first round trip drains ACK-producing parent microtasks. The second
    // crosses the child's FIFO input after any prematurely queued ACK. Both
    // happen with storage blocked; no immediate promise-state/timing assertion.
    await probe.request("probe");
    expect(await probe.request("probe")).toEqual({ acknowledged: false });
    commit.resolve();
    await sending;
    expect(await probe.request("probe")).toEqual({ acknowledged: true });
  } finally {
    commit.resolve();
    probe?.close();
    await session.close("shutdown");
    await rm(root, { recursive: true, force: true });
  }
});

it("retains scrubbed stderr diagnostics when the host exits after acknowledging a send", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-late-exit-"));
  const entry = join(root, "host.mjs");
  await writeFile(
    entry,
    `
import {createInterface} from 'node:readline';
const out=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const input=JSON.parse(line);
 if(input.method==='open') out({id:input.id,result:{agentId:'native'}});
 else if(input.method==='send') out({id:input.id,result:{runId:'native-run'}});
 else if(input.method==='crash') process.stderr.write('Runtime dependency disappeared; opaque-sdk-secret\\n',()=>process.exit(1));
});
`,
  );
  const exited = Promise.withResolvers<{ deliberate: boolean; message?: string }>();
  const exitFrame = Promise.withResolvers<unknown>();
  let host: SupervisedProcess | undefined;
  let session: Awaited<ReturnType<typeof openCursorSession>> | undefined;
  try {
    session = await openCursorSession(
      {
        threadId: ThreadId.parse("late-exit"),
        cwd: root,
        signal: new AbortController().signal,
        onExit: exited.resolve,
        onFrame(frame) {
          const envelope = CursorEnvelopeSchema.parse(frame.data);
          if (envelope.kind === "host-exit") exitFrame.resolve(envelope.body);
        },
      },
      {
        env: { HOME: root, CURSOR_API_KEY: "opaque-sdk-secret" },
        entry,
        instanceId: "instance",
        spawn(options) {
          host = spawnSupervised(options);
          return host;
        },
      },
    );
    await session.send([{ type: "text", text: "Start work" }], "queue", "late-intent");
    if (!host) throw new Error("Synthetic host unavailable");
    host.stdin.write(JSON.stringify({ method: "crash" }) + "\n");
    expect(await exited.promise).toMatchObject({
      deliberate: false,
      message: "Cursor stopped unexpectedly. Unfinished work needs your attention.",
    });
    expect(await exitFrame.promise).toMatchObject({
      detail: expect.stringContaining("Runtime dependency disappeared"),
    });
    expect(JSON.stringify(await exitFrame.promise)).not.toContain("opaque-sdk-secret");
  } finally {
    await session?.close("shutdown");
    await rm(root, { recursive: true, force: true });
  }
});
