import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { bundleDaemon } from "@ace/release";

test("the desktop daemon bundle loads Pi's extension and launches Cursor's key worker without a checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-provider-helpers-"));
  try {
    const repo = resolve(import.meta.dirname, "../../..");
    const inputs = await bundleDaemon(repo, root, "");
    expect(inputs.some((input) => input.endsWith("packages/adapter-pi/src/extension.ts"))).toBe(
      true,
    );
    expect(
      inputs.some((input) => input.endsWith("packages/adapter-cursor/src/api-key-entry.ts")),
    ).toBe(true);
    // Every relative source entry must have been rewritten to a deployable artifact.
    for (const file of await readdir(root))
      if (file.endsWith(".mjs")) {
        const source = await readFile(join(root, file), "utf8");
        expect(source).not.toMatch(/new URL\(["'][.][./][^"']*\.ts["'],\s*import\.meta\.url\)/);
      }
    await writeFile(join(root, "session.json"), JSON.stringify({ controlSecret: "a".repeat(64) }), {
      mode: 0o600,
    });
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import extension from './pi-extension.mjs';
const handlers=new Map(),commands=new Map(),notices=[];
await extension({on(event,handler){handlers.set(event,handler)},registerCommand(name,command){commands.set(name,command)},appendEntry(){},registerTool(){}},{ACE_PI_SESSION_FILE:process.cwd()+'/session.json'});
handlers.get('turn_end')({}, {sessionManager:{getLeafId:()=> 'native-boundary'},ui:{notify:message=>notices.push(JSON.parse(message))}});
console.log(JSON.stringify(notices));
`,
      ],
      { cwd: root, env: { HOME: root, PATH: "" } },
    );
    expect(JSON.parse(result.stdout)).toEqual([
      { type: "ace_turn_boundary", entryId: "native-boundary" },
    ]);
    // A synthetic key reaches only the SDK-owned temporary store, with no vendor output.
    const worker = spawn(process.execPath, [join(root, "cursor-api-key.mjs")], {
      cwd: root,
      env: { HOME: root, PATH: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    worker.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    worker.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    const exited = once(worker, "close");
    worker.stdin.end("sdk-packaged-synthetic-key-not-a-live-credential");
    expect((await exited)[0]).toBe(0);
    expect((await stat(join(root, ".cursor", "sdk", "auth.json"))).mode & 0o777).toBe(0o600);
    expect(output).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
