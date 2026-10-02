import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { WorkspaceError } from "./index.ts";
import { fixture } from "./test-support.ts";

it("never returns outside bytes while a real child swaps a parent directory for a symlink", async () => {
  const inside = await fixture();
  const outside = await fixture();
  await inside.file("changing/file", "inside");
  await outside.file("file", "OUTSIDE SECRET");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { renameSync, symlinkSync, unlinkSync } from 'node:fs';
    import { join } from 'node:path';
    const [root, outside] = process.argv.slice(1);
    const path = join(root, 'changing');
    const parked = join(root, 'parked');
    let stopped = false;
    process.on('message', () => { stopped = true; });
    let cycles = 0;
    while (!stopped) {
      renameSync(path, parked);
      symlinkSync(outside, path);
      await new Promise(resolve => setImmediate(resolve));
      unlinkSync(path);
      renameSync(parked, path);
      await new Promise(resolve => setImmediate(resolve));
      if (++cycles === 1) process.send('ready');
    }
    process.disconnect();
  `,
      inside.root,
      outside.root,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const exited = once(child, "exit");
  const errors: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
  try {
    await once(child, "message");
    for (let index = 0; index < 100; index++) {
      try {
        const result = await inside.service.read({ path: "changing/file" });
        expect(result).toMatchObject({ text: "inside" });
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        expect(error.code, String(error)).toMatch(
          /^(NOT_FOUND|NOT_DIRECTORY|PATH_ESCAPE|PATH_CHANGED)$/,
        );
      }
    }
  } finally {
    child.send("stop");
    const [code] = await exited;
    expect(code, errors.join("")).toBe(0);
  }
  expect(await inside.service.read({ path: "changing/file" })).toMatchObject({ text: "inside" });
});
