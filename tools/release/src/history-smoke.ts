import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFile } from "@ace/service";
import type { ReleaseTarget } from "@ace/protocol";
import type { z } from "zod";
import { historySizeLimit, stagedAceHistory } from "./ace-history.ts";
import { runShipped } from "./native-smoke.ts";
import { checkLinuxRustBinary } from "./rust-binary.ts";

type Target = z.infer<typeof ReleaseTarget>;

/**
 * Starts the staged ace-history through the shipped daemon runtime, sends the options the
 * daemon sends (a scratch index, no homes), requires `ready` back, then closes stdin, which is
 * how the reader is stopped, and expects a clean exit.
 */
export async function smokeHistory(root: string, target: Target, runtime: string): Promise<void> {
  const binary = stagedAceHistory(root, target);
  if ((await stat(binary)).size > historySizeLimit)
    throw new Error(`ace-history exceeds ${historySizeLimit} bytes`);
  const scratch = await mkdtemp(join(tmpdir(), "ace-history-smoke-"));
  try {
    const output = runShipped(runtime, [
      "-e",
      readySmokeScript(binary, join(scratch, "index.sqlite")),
    ]);
    if (output.trim()) throw new Error("Unexpected history smoke output");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  if (target.startsWith("linux-")) await checkLinuxRustBinary("ace-history", binary);
  process.stdout.write(
    `ace-history ${target}: ready handshake and clean exit passed (${await hashFile(binary)})\n`,
  );
}

function readySmokeScript(binary: string, indexPath: string): string {
  return `
const { spawn } = require("node:child_process");
const child = spawn(${JSON.stringify(binary)}, [], { stdio: ["pipe", "pipe", "inherit"] });
const fail = (message) => { console.error(message); child.kill("SIGKILL"); process.exit(1); };
const timer = setTimeout(() => fail("ace-history sent no ready"), 10000);
const json = Buffer.from(JSON.stringify({ init: { indexPath: ${JSON.stringify(indexPath)}, instances: [] } }));
const header = Buffer.alloc(5);
header.writeUInt32LE(json.length + 1, 0);
header[4] = 1;
child.stdin.write(Buffer.concat([header, json]));
let held = Buffer.alloc(0);
let ready = false;
child.stdout.on("data", (chunk) => {
  held = Buffer.concat([held, chunk]);
  if (held.length < 5) return;
  const length = held.readUInt32LE(0);
  if (held.length < 4 + length) return;
  const message = JSON.parse(held.subarray(5, 4 + length).toString("utf8"));
  if (message.id !== 0 || message.value !== "ready") return fail("ace-history answered " + JSON.stringify(message));
  ready = true;
  clearTimeout(timer);
  child.stdin.end();
  setTimeout(() => fail("ace-history did not exit after stdin closed"), 10000).unref();
});
child.on("exit", (code) => {
  if (!ready) fail("ace-history exited before ready");
  else if (code !== 0) fail("ace-history did not shut down cleanly (" + code + ")");
  process.exit(0);
});
`;
}
