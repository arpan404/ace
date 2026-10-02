import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
export async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "ace-diag-test-"));
  roots.push(root);
  return root;
}
const noop = () => {};
export function deferred<T>() {
  let resolve: (value: T) => void = noop;
  let reject: (error: Error) => void = noop;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
