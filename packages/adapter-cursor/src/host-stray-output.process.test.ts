import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { openCursorSession, CursorEnvelopeSchema } from "./index.ts";
import { CursorHost } from "./host.ts";

const secret = "crsr_0123456789abcdef0123456789abcdef";
// The session's ace MCP bearer: bare hex, which only an exact-value redaction catches.
const bearer = "7f3a9c1e5b8d2f4a6c0e9b7d5f3a1c8e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a";

/** A host that writes `stray` to stdout before answering "send", as stray SDK output would. */
const hostWriting = (stray: string) => `
import {createInterface} from 'node:readline';
const out=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const input=JSON.parse(line);
 if(input.method==='open') out({id:input.id,result:{agentId:'native'}});
 else if(input.method==='send') {
  process.stdout.write(${JSON.stringify(stray)}+'\\n');
  out({id:input.id,result:{runId:'native-run'}});
 } else if(input.id!==undefined) out({id:input.id,result:{}});
});
`;

async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), "cursor-stray-"));
  const entry = join(root, "host.mjs");
  await writeFile(entry, source);
  return {
    root,
    entry,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

it("a non-JSON line on the host's stdout is kept as redacted raw output and the turn goes on", async () => {
  const files = await fixture(
    hostWriting(`Warning, gif stream shorter than expected ${secret} lease ${bearer}`),
  );
  const exits: unknown[] = [];
  const kinds = new Map<string, unknown>();
  const session = await openCursorSession(
    {
      threadId: ThreadId.parse("stray-output"),
      cwd: files.root,
      signal: new AbortController().signal,
      onExit: (exit) => exits.push(exit),
      onFrame(frame) {
        const envelope = CursorEnvelopeSchema.parse(frame.data);
        kinds.set(envelope.kind, envelope.body);
      },
    },
    {
      env: { HOME: files.root, CURSOR_API_KEY: secret },
      entry: files.entry,
      instanceId: "instance",
      mcp: { url: "http://127.0.0.1:4321/mcp", bearer },
    },
  );
  try {
    await session.send([{ type: "text", text: "Start work" }], "queue", "stray-intent");
    await sleep(100);
    expect(exits).toEqual([]);
    const output = JSON.stringify(kinds.get("host-output"));
    expect(output).toContain("gif stream shorter than expected");
    expect(output).not.toContain(secret);
    expect(output).not.toContain(bearer);
  } finally {
    await session.close("shutdown");
    await files.remove();
  }
});

// The host is ace's own code: JSON that is not a JSON-RPC message means the protocol broke.
it("a JSON line from the host that is not a JSON-RPC message still stops the host", async () => {
  const files = await fixture(
    `process.stdout.write('{"hello":1}\\n'); setInterval(() => {}, 1000);`,
  );
  const host = new CursorHost({ env: { HOME: files.root }, entry: files.entry }, () => {});
  try {
    await host.process.exited;
    expect(host.stopCause).toBe("Cursor SDK host sent a malformed message");
  } finally {
    await host.stop();
    await files.remove();
  }
});

// A native write with no newline joins the next JSON-RPC line; keeping that line as output would
// silently drop the reply (or the fence notice) inside it.
it("stray text joined to a JSON-RPC message on one line still stops the host", async () => {
  const files = await fixture(`
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const {id}=JSON.parse(line);
 process.stdout.write('native warning without a newline ');
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result:{models:[]}})+'\\n');
});
`);
  const host = new CursorHost({ env: { HOME: files.root }, entry: files.entry }, () => {});
  try {
    await expect(host.request("models")).rejects.toThrow();
    expect(host.stopCause).toBe("Cursor SDK host sent a malformed message");
  } finally {
    await host.stop();
    await files.remove();
  }
});
