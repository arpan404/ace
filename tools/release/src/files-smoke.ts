import { stat } from "node:fs/promises";
import { hashFile } from "@ace/service";
import type { ReleaseTarget } from "@ace/protocol";
import type { z } from "zod";
import { filesSizeLimit, stagedAceFiles } from "./ace-files.ts";
import { runShipped } from "./native-smoke.ts";
import { checkLinuxRustBinary } from "./rust-binary.ts";

type Target = z.infer<typeof ReleaseTarget>;

/**
 * Starts the staged ace-files through the shipped daemon runtime, from the shipped layout with
 * no source imports, completes the files-wire hello handshake on its stdio and expects it to exit
 * cleanly when stdin closes: exactly what the daemon does when it starts the process.
 */
export async function smokeFiles(root: string, target: Target, runtime: string): Promise<void> {
  const binary = stagedAceFiles(root, target);
  if ((await stat(binary)).size > filesSizeLimit)
    throw new Error(`ace-files exceeds ${filesSizeLimit} bytes`);
  const output = runShipped(runtime, ["-e", helloSmokeScript(binary)]);
  if (output.trim()) throw new Error("Unexpected files smoke output");
  if (target.startsWith("linux-")) await checkLinuxRustBinary("ace-files", binary);
  process.stdout.write(
    `ace-files ${target}: hello handshake and clean exit passed (${await hashFile(binary)})\n`,
  );
}

/**
 * The driver the shipped runtime runs: it frames `hello` the way files-wire does (u32 LE length
 * of the rest, kind byte 1, JSON), waits for ace-files' hello on kind 1, then closes stdin, which
 * is how the process is stopped.
 */
function helloSmokeScript(binary: string): string {
  return `
const { spawn } = require("node:child_process");
const child = spawn(${JSON.stringify(binary)}, { stdio: ["pipe", "pipe", "pipe"] });
child.stdin.on("error", () => {});
const frame = (message) => {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(1 + json.length, 0);
  return Buffer.concat([header, Buffer.from([1]), json]);
};
const fail = (reason) => {
  console.error(reason);
  child.kill();
  process.exit(1);
};
const timer = setTimeout(() => fail("ace-files sent no hello"), 10000);
let buffered = Buffer.alloc(0);
let greeted = false;
child.stdout.on("data", (chunk) => {
  if (greeted) return;
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32LE(0);
    if (buffered.length < 4 + length) return;
    const payload = buffered.subarray(4, 4 + length);
    buffered = buffered.subarray(4 + length);
    if (payload[0] !== 1) continue;
    const message = JSON.parse(payload.subarray(1).toString("utf8"));
    if (message.type !== "hello") continue;
    if (message.protocol !== 1)
      return fail("ace-files answered another protocol: " + message.protocol);
    greeted = true;
    clearTimeout(timer);
    child.stdin.end();
    return;
  }
});
child.stderr.on("data", () => {});
child.on("error", fail);
child.on("exit", (code) => {
  clearTimeout(timer);
  if (!greeted) fail("ace-files exited before hello");
  else if (code !== 0) fail("ace-files did not shut down cleanly (" + code + ")");
  else process.exit(0);
});
child.stdin.write(frame({ type: "hello", protocol: 1 }));
`;
}
