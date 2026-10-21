import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it, onTestFinished } from "vitest";
import { listProcesses, procEntry } from "./process-table.ts";

it("finds a detached process by its command line with its own process group", async () => {
  const marker = `ace-marker-${process.pid}-${performance.now()}`;
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", marker], {
    detached: true,
    stdio: "ignore",
  });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  await once(child, "spawn");
  const entry = (await listProcesses(process.platform)).find((row) =>
    `${row.command} `.includes(` ${marker} `),
  );
  expect(entry).toMatchObject({ pid: child.pid, group: child.pid });
  expect(entry?.state).not.toMatch(/^Z/);
});

it("reads a Linux process whose name holds spaces and parentheses", () => {
  const stat = "4242 (Web Content (x)) S 1 4240 4240 0 -1 4194560 0 0";
  expect(procEntry(stat, "/opt/chrome\0--type=renderer\0--user-data-dir=/p a\0")).toEqual({
    pid: 4242,
    group: 4240,
    state: "S",
    command: "/opt/chrome --type=renderer --user-data-dir=/p a",
  });
  expect(procEntry("4243 (z) Z 1 4243 4243", "")).toMatchObject({ state: "Z", command: "" });
});
