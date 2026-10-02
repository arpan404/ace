import { execFile } from "node:child_process";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inject } from "vitest";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";

const execute = promisify(execFile);

export async function gitFixture(prefix: string, name: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const dir = join(root, name);
  await cp(inject("gitTemplate"), dir, { recursive: true });
  const cli = async (...args: string[]) =>
    execute("git", ["-C", dir, ...args], { timeout: PROCESS_TEST_TIMEOUT });
  return { root, dir, cli };
}
