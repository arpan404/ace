import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { openCursorSession, CursorEnvelopeSchema } from "./index.ts";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";

const fatalModule = pathToFileURL(join(import.meta.dirname, "host-fatal.ts")).href;

/** A host that crashes on "crash": a Node warning, then its fatal line, then noise, then exit. */
const crashingHost = `
import {createInterface} from 'node:readline';
import {fatalLine} from ${JSON.stringify(fatalModule)};
const out=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const input=JSON.parse(line);
 if(input.method==='open') out({id:input.id,result:{agentId:'native'}});
 else if(input.method==='send') out({id:input.id,result:{runId:'native-run'}});
 else if(input.method==='crash') {
  const error=new TypeError('Cannot read properties of undefined (reading opaque-sdk-secret)');
  process.stderr.write('(node:4242) Warning: something unrelated\\n');
  process.stderr.write(fatalLine('uncaughtException', error));
  process.stderr.write('(Use \`node --trace-warnings ...\` to show where the warning was created)\\n',()=>process.exit(1));
 }
});
`;

async function crash(entrySource: string) {
  const root = await mkdtemp(join(tmpdir(), "cursor-fatal-"));
  const entry = join(root, "host.mjs");
  await writeFile(entry, entrySource);
  const exited = Promise.withResolvers<{ deliberate: boolean; message?: string }>();
  const exitFrame = Promise.withResolvers<unknown>();
  let host: SupervisedProcess | undefined;
  const session = await openCursorSession(
    {
      threadId: ThreadId.parse("fatal-exit"),
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
  try {
    await session.send([{ type: "text", text: "Start work" }], "queue", "fatal-intent");
    if (!host) throw new Error("Synthetic host unavailable");
    host.stdin.write(JSON.stringify({ method: "crash" }) + "\n");
    return { exit: await exited.promise, frame: await exitFrame.promise };
  } finally {
    await session.close("shutdown");
    await rm(root, { recursive: true, force: true });
  }
}

it("a host that crashes on an uncaught error tells the person why, not its last stderr line", async () => {
  const { exit, frame } = await crash(crashingHost);
  expect(exit.deliberate).toBe(false);
  expect(exit.message).toMatch(
    /^Cursor stopped unexpectedly: uncaughtException: TypeError: Cannot read properties of undefined .*\. Unfinished work needs your attention\.$/,
  );
  expect(frame).toMatchObject({
    deliberate: false,
    code: 1,
    detail: expect.stringContaining("TypeError: Cannot read properties of undefined"),
  });
  const evidence = JSON.stringify({ exit, frame });
  expect(evidence).not.toContain("trace-warnings");
  expect(evidence).not.toContain("opaque-sdk-secret");
});

it("a host that exits with only warnings on stderr keeps the plain stop message", async () => {
  const { exit, frame } = await crash(
    crashingHost.replace(
      "process.stderr.write(fatalLine('uncaughtException', error));",
      "void error;",
    ),
  );
  expect(exit.message).toBe("Cursor stopped unexpectedly. Unfinished work needs your attention.");
  expect(JSON.stringify(frame)).not.toContain("trace-warnings");
});
