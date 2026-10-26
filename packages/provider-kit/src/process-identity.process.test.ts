import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { processIdentity } from "./process-identity.ts";

/** The owner the OS reports for this test process: a token SID on Windows, a uid elsewhere. */
async function currentOwner(): Promise<string | number | undefined> {
  if (process.platform !== "win32") return process.getuid?.();
  const { stdout } = await promisify(execFile)("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    windowsHide: true,
  });
  return stdout.match(/"(S-\d+(?:-\d+)+)"\s*$/m)?.[1];
}

test("kernel identity keeps a stable start and the real owner of a live process", async () => {
  const owner = await currentOwner();
  expect(owner).toBeDefined();
  const identity = processIdentity(process.pid);
  expect(identity?.pid).toBe(process.pid);
  expect(identity?.uid).toBe(owner);
  expect(identity?.start).toMatch(/^[\d:a-f-]+$/);
  expect(processIdentity(process.pid)).toEqual(identity);
});
