import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import type { ProcessExit, SupervisedProcess } from "@ace/provider-kit/process";
import { spawnSdkProcess } from "./sdk-process.ts";

/** A Claude CLI whose stdout the test writes, and whose exit the test decides. */
function fakeClaude() {
  const out = new PassThrough();
  const exit = Promise.withResolvers<ProcessExit>();
  const process: SupervisedProcess = {
    pid: 1,
    stdin: new PassThrough(),
    stdout: createInterface({ input: out, crlfDelay: Infinity }),
    stderr: createInterface({ input: new PassThrough(), crlfDelay: Infinity }),
    exited: exit.promise,
    signal: new AbortController().signal,
    stop: () => exit.promise,
  };
  return { process, out, exit };
}

it("a line that arrives after Claude exited is kept as wire data, and the daemon keeps running", async () => {
  const claude = fakeClaude();
  const wire: unknown[] = [];
  const spawned = spawnSdkProcess(
    { command: "claude", args: [], env: {}, signal: new AbortController().signal },
    {
      onStderr: () => {},
      onWire: (_dir, data) => void wire.push(data),
      onProcess: () => {},
      spawn: () => claude.process,
    },
  );
  const exited = new Promise((resolve) => spawned.on("exit", resolve));
  claude.exit.resolve({ code: 0, signal: null, reason: "exit" });
  await exited;
  claude.out.write(`${JSON.stringify({ type: "result", subtype: "success" })}\n`);
  // A write after end would surface on the next turn as an unhandled stream error.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(wire).toContainEqual({
    type: "late_stdout",
    line: JSON.stringify({ type: "result", subtype: "success" }),
  });
});
