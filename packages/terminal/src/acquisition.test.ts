import { expect, test } from "vitest";
import { access } from "node:fs/promises";
import { TerminalManager, createPosixBackendFactory } from "./index.ts";
import type { NativePty } from "./index.ts";
import { fixture } from "./test-support.ts";

const noop = () => {};
async function missingCleanup() {
  throw new Error("No owned cleanup handle returned");
}

test("a native spawn failure disposes its acquired ownership lease", () => {
  let leaseOpen = false;
  const manager = new TerminalManager({
    dependencies: {
      backendFactory: createPosixBackendFactory({
        spawn() {
          throw new Error("Spawn unavailable");
        },
        processes: { read: async () => [], signal: noop },
        createLease() {
          leaseOpen = true;
          return {
            path: "/controlled-fifo",
            readyPath: "/controlled-ready",
            ready: () => true,
            alive: () => leaseOpen,
            dispose() {
              leaseOpen = false;
            },
          };
        },
      }),
    },
  });
  expect(() => manager.openTerminal({ cwd: "/tmp", cols: 80, rows: 24, name: "failure" })).toThrow(
    "Spawn unavailable",
  );
  expect(leaseOpen).toBe(false);
});

test("failed fixture acquisition removes its temporary workspace and permits repeated cleanup", async () => {
  let path = "";
  let cleanup: () => Promise<void> = missingCleanup;
  await expect(
    fixture(
      {
        dependencies: {
          backendFactory(options) {
            path = options.cwd;
            throw new Error("Acquisition failure");
          },
        },
      },
      (registered) => {
        cleanup = registered;
      },
    ),
  ).rejects.toThrow("Acquisition failure");
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  await cleanup();
  await cleanup();
});

test("manager shutdown stops another terminal when one inventory remains unavailable", async () => {
  const rows: Array<{ pid: number; state: string }> = [];
  let nextPid = 40;
  const manager = new TerminalManager({
    graceMs: 0,
    dependencies: {
      backendFactory(options, shell, context) {
        const row = { pid: ++nextPid, state: "R" };
        rows.push(row);
        let exit: (value: unknown) => void = noop;
        const native: NativePty = {
          pid: row.pid,
          write: noop,
          resize: noop,
          onData: () => ({ dispose: noop }),
          onExit(listener) {
            exit = listener;
            return { dispose: noop };
          },
        };
        return createPosixBackendFactory({
          spawn: () => native,
          createLease: () => ({
            path: "/fifo",
            readyPath: "/ready",
            ready: () => true,
            alive: () => true,
            dispose: noop,
          }),
          processes: {
            async read() {
              if (row.pid === 41) throw new Error("Inventory unavailable");
              return [{ ...row, group: row.pid, owner: context.owner }];
            },
            signal(_group, signal) {
              if (signal === "SIGKILL") {
                row.state = "Z";
                exit({ exitCode: 0, signal: 9 });
              }
            },
          },
        })(options, shell, context);
      },
    },
  });
  manager.openTerminal({ cwd: "/tmp", cols: 80, rows: 24, name: "unavailable" });
  manager.openTerminal({ cwd: "/tmp", cols: 80, rows: 24, name: "available" });
  await expect(manager.closeAll()).rejects.toThrow();
  expect(rows.map((row) => row.state)).toEqual(["R", "Z"]);
});
