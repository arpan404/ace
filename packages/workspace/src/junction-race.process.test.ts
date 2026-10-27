import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";
import { WorkspaceError } from "./index.ts";
import { fixture } from "./test-support.ts";

// Windows refuses to rename a folder while ace holds a handle inside it, so the swapping child
// retries; a junction stands in for the symlink, needing no privilege. Windows also reports a
// folder that is pending deletion as access denied, so that is an allowed refusal here.
test.runIf(process.platform === "win32").each(["reads", "searches"])(
  "never %s outside bytes while a real child swaps a parent folder for a junction",
  async (operation) => {
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
    import { renameSync, rmdirSync, symlinkSync } from 'node:fs';
    import { join } from 'node:path';
    const [root, outside] = process.argv.slice(1);
    const path = join(root, 'changing');
    const parked = join(root, 'parked');
    let stopped = false;
    process.on('message', () => { stopped = true; });
    let cycles = 0;
    const retry = async (step) => {
      for (;;) {
        try { return step(); } catch (error) {
          if (error.code !== 'EPERM' && error.code !== 'EBUSY' && error.code !== 'EACCES') throw error;
          await new Promise(resolve => setImmediate(resolve));
        }
      }
    };
    while (!stopped) {
      await retry(() => renameSync(path, parked));
      await retry(() => symlinkSync(outside, path, 'junction'));
      await new Promise(resolve => setImmediate(resolve));
      await retry(() => rmdirSync(path));
      await retry(() => renameSync(parked, path));
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
          if (operation === "reads") {
            const result = await inside.service.read({ path: "changing/file" });
            expect(result).toMatchObject({ text: "inside" });
          } else {
            // Searches hold directory handles for the pass; none may lead outside.
            const result = await inside.service.search({ query: "SECRET", limit: 10 });
            expect(result.matches).toEqual([]);
          }
        } catch (error) {
          if (!(error instanceof WorkspaceError)) throw error;
          expect(error.code, String(error)).toMatch(
            /^(NOT_FOUND|NOT_DIRECTORY|PATH_ESCAPE|PATH_CHANGED|PERMISSION_DENIED)$/,
          );
        }
      }
    } finally {
      child.send("stop");
      const [code] = await exited;
      expect(code, errors.join("")).toBe(0);
    }
    expect(await inside.service.read({ path: "changing/file" })).toMatchObject({ text: "inside" });
  },
);
