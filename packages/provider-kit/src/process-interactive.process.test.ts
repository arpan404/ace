import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnInteractive, type InteractiveProcess } from "./process-interactive.ts";
import type { TreePorts } from "./process-tree.ts";

const directories: string[] = [];
const handles: InteractiveProcess[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop({ graceMs: 0 })));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** Off Windows, taskkill is stood in for by signalling the leader, so the branch runs anywhere. */
function signalLeader(pid: number, force: boolean): void {
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function track(handle: InteractiveProcess): InteractiveProcess {
  handles.push(handle);
  return handle;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await access(path);
      return;
    } catch {
      // The child has not signaled readiness yet.
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const modes: { name: string; ports: TreePorts }[] = [
  { name: "process group", ports: {} },
  // An unjoinable job (none on this host) keeps the tree stop in charge.
  {
    name: "Windows tree stop",
    ports: { platform: "win32", killTree: signalLeader, jobFactory: () => undefined },
  },
];

// Off Windows; real Windows login consoles are covered by the accounts suite.
describe.skipIf(process.platform === "win32").each(modes)(
  "interactive login in its $name",
  ({ ports }) => {
    it("reports a clean exit", async () => {
      const proc = track(
        spawnInteractive({
          ...ports,
          command: process.execPath,
          args: ["-e", "process.exit(3)"],
          env: {},
        }),
      );
      expect(await proc.exited).toEqual({ code: 3, signal: null, reason: "exit" });
    });

    it("stops gracefully, then forces after the grace", async () => {
      const root = await mkdtemp(join(tmpdir(), "ace-interactive-stop-"));
      directories.push(root);
      const ready = join(root, "ready");
      const proc = track(
        spawnInteractive({
          ...ports,
          command: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync(process.env.READY, 'ready');" +
              "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
          ],
          env: { READY: ready },
        }),
      );
      await waitForFile(ready);
      expect(await proc.stop({ graceMs: 50 })).toMatchObject({
        reason: "stopped",
        signal: "SIGKILL",
      });
    });

    it("reports a login CLI that fails to start", async () => {
      const proc = track(
        spawnInteractive({
          ...ports,
          command: "ace-definitely-missing-login-binary",
          args: [],
          env: {},
        }),
      );
      expect(await proc.exited).toMatchObject({ reason: "spawn-error" });
    });
  },
);

it.skipIf(process.platform === "win32")(
  "routes Windows batch login entrypoints through cmd.exe",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-windows-interactive-cmd-"));
    directories.push(root);
    const record = join(root, "argv");
    await writeFile(join(root, "cmd.exe"), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$ACE_RECORD"\n', {
      mode: 0o755,
    });
    await chmod(join(root, "cmd.exe"), 0o755);
    const proc = track(
      spawnInteractive({
        command: "C:\\tools\\login.cmd",
        args: ["a&b", "%PATH%"],
        env: { PATH: `${root}${delimiter}${process.env.PATH ?? ""}`, ACE_RECORD: record },
        platform: "win32",
        killTree: signalLeader,
        jobFactory: () => undefined,
      }),
    );
    expect(await proc.exited).toMatchObject({ code: 0, reason: "exit" });
    const lines = (await readFile(record, "utf8")).split("\n");
    expect(lines.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(lines[3]).toBe('""C:\\tools\\login.cmd" ^^^"a^^^&b^^^" ^^^"^^^%PATH^^^%^^^""');
  },
);
