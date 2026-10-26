import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { processIdentity } from "./process-identity.ts";

test.skipIf(process.platform !== "win32")(
  "Windows kernel identity keeps the creation time and the real token owner",
  async () => {
    const { stdout } = await promisify(execFile)("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      windowsHide: true,
    });
    const owner = stdout.match(/"(S-\d+(?:-\d+)+)"\s*$/m)?.[1];
    expect(owner).toBeDefined();
    const identity = processIdentity(process.pid);
    expect(identity?.pid).toBe(process.pid);
    expect(identity?.uid).toBe(owner);
    expect(identity?.start).toMatch(/^\d+$/);
    expect(processIdentity(process.pid)).toEqual(identity);
  },
);
