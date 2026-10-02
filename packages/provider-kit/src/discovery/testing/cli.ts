import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Output = { stdout: string; stderr: string; code: number };
export type Capture = { version: Output; auth: Output };
const empty = { stdout: "", stderr: "", code: 0 };
const directories: string[] = [];
export async function directory(base = tmpdir()) {
  const path = await mkdtemp(join(base, "provider-kit-discovery-"));
  directories.push(path);
  // Extensionless Node stand-ins must not inherit the checkout's ESM package scope.
  await writeFile(join(path, "package.json"), JSON.stringify({ type: "commonjs" }));
  return path;
}
export async function cleanupDirectories() {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
}
function quote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}
function print(output: Output): string {
  return `printf '%s' ${quote(output.stdout)}\nprintf '%s' ${quote(output.stderr)} >&2\nexit ${output.code}`;
}
/** Real executable shell stand-ins preserve both streams of captured output. */
export async function binary(root: string, name: string, capture: Partial<Capture>) {
  const path = join(root, name);
  await writeFile(
    path,
    `#!/bin/sh\nif [ "$1" = '--version' ]; then\n${print(capture.version ?? empty)}\nelse\n${print(capture.auth ?? empty)}\nfi\n`,
    { mode: 0o755 },
  );
  return path;
}
export async function fixture(provider: string): Promise<Capture> {
  return JSON.parse(
    await readFile(new URL(`../__fixtures__/${provider}.json`, import.meta.url), "utf8"),
  ) as Capture;
}
