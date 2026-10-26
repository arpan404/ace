import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { openCursorSession, CursorEnvelopeSchema } from "./index.ts";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";

const moduleUrl = (name: string) => pathToFileURL(join(import.meta.dirname, name)).href;
const secret = "opaque-sdk-secret-4f9a2c7e1b8d6053a9e4c1f7b2d8e6a0";

/**
 * A host that crashes on "crash": a Node warning, then its fatal line (redacted the way the real
 * host redacts it), then noise, then exit. `message` is the uncaught error's message, as JS.
 */
const crashingHost = (
  message = "'Cannot read properties of undefined (reading ' + process.env.CURSOR_API_KEY + ')'",
) => `
import {createInterface} from 'node:readline';
import {fatalLine} from ${JSON.stringify(moduleUrl("host-fatal.ts"))};
import {safeCursorErrorMessage} from ${JSON.stringify(moduleUrl("sdk-failure.ts"))};
const redact=text=>safeCursorErrorMessage(text,{CURSOR_API_KEY:process.env.CURSOR_API_KEY});
const out=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const input=JSON.parse(line);
 if(input.method==='open') out({id:input.id,result:{agentId:'native'}});
 else if(input.method==='send') out({id:input.id,result:{runId:'native-run'}});
 else if(input.method==='crash') {
  const error=new TypeError(${message});
  process.stderr.write('(node:4242) Warning: something unrelated\\n');
  process.stderr.write(fatalLine('uncaughtException', error, redact));
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
      env: { HOME: root, CURSOR_API_KEY: secret },
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
  const { exit, frame } = await crash(crashingHost());
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
  expect(evidence).not.toContain("opaque-sdk");
});

it("a credential straddling the fatal line's length cutoff never reaches the person", async () => {
  // The key starts 10 characters before the 2,048-character cutoff of the fatal line.
  const prefix = "uncaughtException: TypeError: ".length;
  const { exit, frame } = await crash(
    crashingHost(`'x'.repeat(${2048 - prefix - 10}) + process.env.CURSOR_API_KEY + ' tail'`),
  );
  const evidence = JSON.stringify({ exit, frame });
  expect(evidence).not.toContain("opaque-sdk");
  expect(evidence).not.toContain(secret.slice(0, 10));
});

it("a host that exits with only warnings on stderr keeps the plain stop message", async () => {
  const { exit, frame } = await crash(
    crashingHost().replace(
      "process.stderr.write(fatalLine('uncaughtException', error, redact));",
      "void error;",
    ),
  );
  expect(exit.message).toBe("Cursor stopped unexpectedly. Unfinished work needs your attention.");
  expect(JSON.stringify(frame)).not.toContain("trace-warnings");
});
