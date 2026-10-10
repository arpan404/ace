import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { CursorHost } from "@ace/adapter-cursor/discovery";

test("recoverable SDK errors and request deadlines leave the host usable", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-cursor-recoverable-"));
  const entry = join(home, "host.mjs");
  await writeFile(
    entry,
    `import {createInterface} from 'node:readline';
const write = data => process.stdout.write(JSON.stringify(data)+'\\n');
for await (const line of createInterface({input:process.stdin})) {
 const request=JSON.parse(line);
 if(request.method==='error') {
  write({method:'frame',params:{schemaVersion:1,generation:'test',operationId:'run',segment:0,kind:'error',body:{message:'Temporary SDK error'}}});
  write({id:request.id,error:{code:-32603,message:'Temporary SDK error'}});
 } else if(request.method==='timeout') {} else write({id:request.id,result:'still usable'});
}`,
  );
  const host = new CursorHost(
    { entry, env: { HOME: home }, generation: () => "test", limits: { graceMs: 0 } },
    () => {},
  );
  try {
    await expect(host.request("error")).rejects.toThrow();
    expect(await host.request("ping")).toBe("still usable");
    // An immediately due request deadline exercises timeout without a wall-clock budget.
    await expect(host.request("timeout", {}, 0)).rejects.toThrow();
    expect(await host.request("ping")).toBe("still usable");
    expect(host.process.signal.aborted).toBe(false);
  } finally {
    await host.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("a terminal SDK error lets the next input use the surviving Cursor session", async () => {
  const { openCursorSession } = await import("./index.ts");
  const { ThreadId } = await import("@ace/protocol");
  const home = await mkdtemp(join(tmpdir(), "ace-cursor-terminal-"));
  const entry = join(home, "host.mjs");
  await writeFile(
    entry,
    `import {createInterface} from 'node:readline';
const write=data=>process.stdout.write(JSON.stringify(data)+'\\n');let sends=0;
for await(const line of createInterface({input:process.stdin})) {
 const req=JSON.parse(line);
 if(req.method==='open')write({id:req.id,result:{agentId:'agent'}});
 else if(req.method==='send' && ++sends===1) {
  write({method:'frame',params:{schemaVersion:1,generation:'test',agentId:'agent',operationId:req.params.operationId,segment:0,kind:'error',body:{message:'Temporary run failure'}}});
  write({id:req.id,error:{message:'Temporary run failure'}});
 }else if(req.method==='close')write({id:req.id,result:{}});
 else write({id:req.id,result:{}});
}`,
  );
  const session = await openCursorSession(
    {
      threadId: ThreadId.parse("recoverable"),
      cwd: home,
      signal: new AbortController().signal,
      onFrame: () => {},
      onExit: () => {},
    },
    { entry, env: { HOME: home }, instanceId: "account", generation: () => "test" },
  );
  try {
    await expect(
      session.send([{ type: "text", text: "first" }], "queue", "first"),
    ).rejects.toThrow();
    await expect(
      session.send([{ type: "text", text: "second" }], "queue", "second"),
    ).resolves.toBeUndefined();
  } finally {
    await session.close("shutdown");
    await rm(home, { recursive: true, force: true });
  }
});
