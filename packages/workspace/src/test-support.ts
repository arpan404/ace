import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach } from "vitest";
import { createWorkspace, type Change, type WorkspaceOptions } from "./index.ts";
export const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
export async function fixture(options: WorkspaceOptions = {}, git = false) {
  const root = await mkdtemp(join(tmpdir(), "ace-workspace-"));
  roots.push(root);
  if (git) await exec("git", ["init", "-q", root]);
  const service = await createWorkspace(root, options);
  return {
    root,
    service,
    async file(path: string, content: string | Uint8Array) {
      const target = join(root, path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content);
    },
  };
}
/** Event acknowledgements, never sleeps, synchronize real filesystem notifications. */
export function batches() {
  const history: Change[][] = [];
  let waiting:
    | { test: (batch: Change[]) => boolean; resolve: (batch: Change[]) => void }
    | undefined;
  return {
    history,
    onChange(batch: Change[]) {
      history.push(batch);
      if (waiting?.test(batch)) {
        const { resolve } = waiting;
        waiting = undefined;
        resolve(batch);
      }
    },
    next(path: string, kind: Change["kind"]): Promise<Change[]> {
      return new Promise((resolve) => {
        waiting = {
          test: (batch) => batch.some((change) => change.path === path && change.kind === kind),
          resolve,
        };
      });
    },
  };
}
