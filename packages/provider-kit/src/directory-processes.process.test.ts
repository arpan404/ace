import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { spawnSupervised } from "./process.ts";
import { terminateDirectoryProcesses } from "./process-bytes.ts";

test("private lease cleanup stops nested processes and preserves siblings with the same path prefix", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-directory-owner-")));
  const lease = join(root, "lease");
  const nested = join(lease, "nested");
  const sibling = join(root, "lease-sibling");
  await mkdir(nested, { recursive: true });
  await mkdir(sibling);
  const children = [nested, sibling].map((cwd) =>
    spawnSupervised({
      command: process.execPath,
      cwd,
      env: {},
      name: "lease-standin",
      args: ["-e", "console.log('ready'); process.stdin.on('data', () => console.log('alive'));"],
    }),
  );
  try {
    await Promise.all(
      children.map(
        (child) => new Promise<void>((resolve) => child.stdout.once("line", () => resolve())),
      ),
    );
    await terminateDirectoryProcesses([lease]);
    const [inside, outside] = children;
    if (!inside || !outside) throw new Error("Missing children");
    expect((await inside.exited).signal).toBe("SIGKILL");
    const response = new Promise<string>((resolve) => outside.stdout.once("line", resolve));
    outside.stdin.write("ping\n");
    expect(await response).toBe("alive");
  } finally {
    await Promise.all(children.map((child) => child.stop({ graceMs: 0 })));
    await rm(root, { recursive: true, force: true });
  }
});
