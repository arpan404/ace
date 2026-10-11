import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { ProcessSpec } from "./runner.ts";

const runnerModule = new URL("./runner.ts", import.meta.url).href;

/** A child that reports its pid, optionally spawns a grandchild, then idles. */
function sleeper(name: string, options: { grandchild?: boolean; exitAfterMs?: number } = {}) {
  const script = [
    "const { spawn } = require('node:child_process');",
    `console.log('pid=' + process.pid);`,
    options.grandchild
      ? "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log('grandchild=' + g.pid);"
      : "",
    options.exitAfterMs !== undefined
      ? `setTimeout(() => process.exit(3), ${options.exitAfterMs});`
      : "",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  return { name, command: process.execPath, args: ["-e", script] } satisfies ProcessSpec;
}

/** Runs the group the way the dev CLI does, in its own process, so we can Ctrl-C it. */
function startRunner(specs: ProcessSpec[]): { child: ChildProcess; output: () => string } {
  const script = `
    const { ProcessGroup, runUntilInterrupted } = await import(${JSON.stringify(runnerModule)});
    const group = new ProcessGroup(${JSON.stringify(specs)}, { output: process.stdout, graceMs: 2000 });
    process.exitCode = await runUntilInterrupted(group);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout?.on("data", (chunk: Buffer) => (text += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (text += chunk.toString()));
  return { child, output: () => text };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(25);
  }
  throw new Error("Timed out");
}

function pids(output: string, key: string): number[] {
  return [...output.matchAll(new RegExp(`${key}=(\\d+)`, "g"))].map((match) => Number(match[1]));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
}

describe.skipIf(process.platform === "win32")("dev process runner", () => {
  it.each(["ignore", "inherit"])(
    "shutdown finishes with %s pipes after a launcher exits before its TERM-resistant descendant",
    async (pipes) => {
      const descendant =
        "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)";
      const spec: ProcessSpec = {
        name: "launcher",
        command: process.execPath,
        args: [
          "-e",
          `process.on('SIGTERM',()=>process.exit(0));const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',${pipes === "inherit" ? "process.stdout,process.stderr" : "'ignore','ignore'"},'ipc']});c.on('message',()=>console.log('grandchild='+c.pid));setInterval(()=>{},1000);`,
        ],
      };
      const runner = startRunner([spec]);
      let pid: number | undefined;
      try {
        pid = await waitFor(() => pids(runner.output(), "grandchild")[0]);
        runner.child.kill("SIGINT");
        expect(
          await Promise.race([
            exited(runner.child),
            delay(5_000).then(() => {
              throw new Error("Shutdown did not finish");
            }),
          ]),
        ).toBe(0);
        await waitFor(() => (pid !== undefined && !alive(pid) ? true : undefined));
      } finally {
        if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
        runner.child.kill("SIGKILL");
        await exited(runner.child);
      }
    },
  );
  it.each(["ignore", "inherit"])(
    "cleans a surviving descendant with %s pipes when its launcher fails",
    async (pipes) => {
      const descendant =
        "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)";
      const spec: ProcessSpec = {
        name: "launcher",
        command: process.execPath,
        args: [
          "-e",
          `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',${pipes === "inherit" ? "process.stdout,process.stderr" : "'ignore','ignore'"},'ipc']});c.on('message',()=>{console.log('grandchild='+c.pid);process.exit(3);});`,
        ],
      };
      const runner = startRunner([spec]);
      let pid: number | undefined;
      try {
        pid = await waitFor(() => pids(runner.output(), "grandchild")[0]);
        const code = await Promise.race([
          exited(runner.child),
          delay(3_000).then(() => {
            throw new Error("Runner did not finish descendant cleanup");
          }),
        ]);
        expect(code).toBe(3);
        await delay(100);
        expect(alive(pid)).toBe(false);
      } finally {
        if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
        runner.child.kill("SIGKILL");
        await exited(runner.child);
      }
    },
  );
  it("stops every child and grandchild on Ctrl-C and exits cleanly", async () => {
    const runner = startRunner([sleeper("daemon", { grandchild: true }), sleeper("web")]);
    const started = await waitFor(() => {
      const found = [...pids(runner.output(), "pid"), ...pids(runner.output(), "grandchild")];
      return found.length === 3 ? found : undefined;
    });
    expect(started.every(alive)).toBe(true);

    runner.child.kill("SIGINT");
    expect(await exited(runner.child)).toBe(0);
    await waitFor(() => (started.some(alive) ? undefined : true));
  });

  it("prefixes each process's lines with its name", async () => {
    const runner = startRunner([sleeper("daemon"), sleeper("web")]);
    await waitFor(() => (pids(runner.output(), "pid").length === 2 ? true : undefined));
    expect(runner.output()).toMatch(/^daemon │ pid=\d+$/m);
    expect(runner.output()).toMatch(/^web {4}│ pid=\d+$/m);
    runner.child.kill("SIGINT");
    await exited(runner.child);
  });

  it("stops the others and fails when one process exits on its own", async () => {
    const runner = startRunner([sleeper("daemon", { exitAfterMs: 300 }), sleeper("web")]);
    const code = await exited(runner.child);
    expect(code).toBe(3);
    expect(runner.output()).toContain("daemon │ exited (code 3); stopping the others");
    const web = pids(runner.output(), "pid");
    expect(web.some(alive)).toBe(false);
  });
});
