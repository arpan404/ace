import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { ReleaseTarget } from "@ace/protocol";
import { z } from "zod";
import { smokeFiles } from "./files-smoke.ts";

const repo = resolve(import.meta.dirname, "../../..");
const host = ReleaseTarget.parse(`${process.platform}-${process.arch}`);

/** A golden wire vector (`native/files/vectors`): the frame is the exact bytes on the wire. */
const Vector = z.object({
  json: z.record(z.string(), z.unknown()),
  text: z.string(),
  frame: z.string(),
});
const AceFilesHello = Vector.extend({
  json: z.object({ type: z.literal("hello"), protocol: z.number(), version: z.string() }),
});

async function vector(name: string): Promise<z.infer<typeof Vector>> {
  const file = join(repo, "native/files/vectors", `${name}.json`);
  return Vector.parse(JSON.parse(await readFile(file, "utf8")));
}

const daemonHello = await vector("hello-daemon");
const aceFilesHello = AceFilesHello.parse(await vector("hello-ace-files"));

/** The same frame with one field's value replaced; the field must occupy the same bytes. */
function replaceInFrame(frame: string, from: string, to: string): Buffer {
  const bytes = Buffer.from(frame, "hex");
  const at = bytes.indexOf(Buffer.from(from, "utf8"));
  if (at === -1 || from.length !== to.length) throw new Error(`cannot patch ${from} in the vector`);
  bytes.write(to, at, "utf8");
  return bytes;
}

/**
 * A fake ace-files that requires exactly the daemon's hello vector on stdin before it answers
 * with `reply`, then exits cleanly when stdin closes.
 */
function answering(reply: Buffer): string {
  return `#!/usr/bin/env node
const request = Buffer.from(${JSON.stringify(daemonHello.frame)}, "hex");
const answer = Buffer.from(${JSON.stringify(reply.toString("hex"))}, "hex");
let input = Buffer.alloc(0);
let answered = false;
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  if (input.length < request.length) return;
  if (!input.equals(request)) process.exit(4);
  if (!answered) {
    answered = true;
    process.stdout.write(answer);
  }
});
process.stdin.on("end", () => process.exit(0));
`;
}

/** Stages `script` as the bundle's ace-files and returns the bundle root. */
async function staged(script: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ace-files-smoke-"));
  const binary = join(root, "files", "ace-files");
  await mkdir(join(root, "files"), { recursive: true });
  await writeFile(binary, script, { mode: 0o755 });
  return root;
}

test.runIf(process.platform !== "win32")(
  "the staged binary answers the daemon's hello bytes and the smoke passes",
  async ({ onTestFinished }) => {
    const root = await staged(answering(Buffer.from(aceFilesHello.frame, "hex")));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await expect(
      smokeFiles(root, host, aceFilesHello.json.version, process.execPath),
    ).resolves.toBeUndefined();
  },
);

test.runIf(process.platform !== "win32")(
  "a binary that exits before the handshake fails the smoke",
  async ({ onTestFinished }) => {
    const root = await staged("#!/usr/bin/env node\nprocess.exit(0);\n");
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await expect(
      smokeFiles(root, host, aceFilesHello.json.version, process.execPath),
    ).rejects.toThrow(/ace-files exited before hello/);
  },
);

test.runIf(process.platform !== "win32")(
  "a binary that answers another protocol fails the smoke",
  async ({ onTestFinished }) => {
    const reply = replaceInFrame(aceFilesHello.frame, '"protocol":1', '"protocol":2');
    const root = await staged(answering(reply));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await expect(
      smokeFiles(root, host, aceFilesHello.json.version, process.execPath),
    ).rejects.toThrow(/ace-files answered another protocol: 2/);
  },
);

test.runIf(process.platform !== "win32")(
  "a binary that reports another version fails the smoke",
  async ({ onTestFinished }) => {
    const root = await staged(answering(Buffer.from(aceFilesHello.frame, "hex")));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await expect(smokeFiles(root, host, "9.9.9", process.execPath)).rejects.toThrow(
      new RegExp(`ace-files reports version ${aceFilesHello.json.version}, not 9.9.9`),
    );
  },
);
