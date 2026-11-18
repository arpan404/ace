import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { ReleaseTarget } from "@ace/protocol";
import { smokeFiles } from "./files-smoke.ts";

const host = ReleaseTarget.parse(`${process.platform}-${process.arch}`);

const frameHelper = `
const frame = (message) => {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(1 + json.length, 0);
  return Buffer.concat([header, Buffer.from([1]), json]);
};`;

/** A fake ace-files: answers our hello frame with the protocol in `protocol`, then exits on EOF. */
const answering = (protocol: number) => `#!/usr/bin/env node
${frameHelper}
let buffered = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32LE(0);
    if (buffered.length < 4 + length) return;
    const payload = buffered.subarray(4, 4 + length);
    buffered = buffered.subarray(4 + length);
    if (payload[0] !== 1) continue;
    const message = JSON.parse(payload.subarray(1).toString("utf8"));
    if (message.type !== "hello") continue;
    process.stdout.write(frame({ type: "hello", protocol: ${protocol}, version: "0.1.0" }));
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/** Stages `script` as the bundle's ace-files and returns the bundle root. */
async function staged(script: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ace-files-smoke-"));
  const binary = join(root, "files", "ace-files");
  await mkdir(join(root, "files"), { recursive: true });
  await writeFile(binary, script, { mode: 0o755 });
  return root;
}

test.runIf(process.platform !== "win32")(
  "the staged binary answers hello and the smoke passes",
  async ({ onTestFinished }) => {
    const root = await staged(answering(1));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await expect(smokeFiles(root, host, process.execPath)).resolves.toBeUndefined();
  },
);

test.runIf(process.platform !== "win32")(
  "a binary that exits before the handshake fails the smoke",
  async ({ onTestFinished }) => {
    const root = await staged("#!/usr/bin/env node\nprocess.exit(0);\n");
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await expect(smokeFiles(root, host, process.execPath)).rejects.toThrow(
      /ace-files exited before hello/,
    );
  },
);

test.runIf(process.platform !== "win32")(
  "a binary that answers another protocol fails the smoke",
  async ({ onTestFinished }) => {
    const root = await staged(answering(2));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await expect(smokeFiles(root, host, process.execPath)).rejects.toThrow(
      /ace-files answered another protocol: 2/,
    );
  },
);
