/*
 * A computer-use world for process tests: the real client and toolkit over real fake-helper
 * child processes, registered in a real tool registry and called as an agent would.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import type { Scheduler } from "../../runtime.ts";
import { ComputerClient, type ComputerClientOptions } from "../client.ts";
import { computerToolkit, type ComputerToolkitOptions } from "../toolkit.ts";

const fake = fileURLToPath(new URL("./fake-computer-helper.ts", import.meta.url));

export interface WorldOptions {
  env?: Record<string, string>;
  client?: Partial<ComputerClientOptions>;
  toolkit?: ComputerToolkitOptions;
}

/** A scheduler whose time moves only when the test says so. */
export function manualScheduler() {
  let now = 0;
  const timers: { due: number; run: () => void; live: boolean }[] = [];
  const scheduler: Scheduler = {
    after(ms, run) {
      const timer = { due: now + ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  };
  const elapse = (ms: number) => {
    now += ms;
    for (const timer of timers.splice(0)) {
      if (!timer.live) continue;
      if (timer.due <= now) timer.run();
      else timers.push(timer);
    }
  };
  return { scheduler, elapse };
}

function exited(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
}

export async function computerWorld(options: WorldOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ace-computer-"));
  const logPath = join(dir, "ops.log");
  const children: ChildProcessWithoutNullStreams[] = [];
  let next = 0;
  const client = new ComputerClient({
    helper: async () => "fake-helper",
    nextId: () => `r${++next}`,
    spawnHelper: (_command, args) => {
      const child = spawn(process.execPath, [fake, ...args], {
        env: { ...process.env, FAKE_LOG: logPath, ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      return child;
    },
    ...options.client,
  });
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  computerToolkit(client, options.toolkit).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "s",
      threadId: "thread",
      agentId: "root",
      capabilities: ["screen"],
    }),
    new AbortController().signal,
  );
  const call = async (
    name: string,
    args: Record<string, unknown>,
    signal = new AbortController().signal,
  ) => {
    const result = await registry.call(name, args, lease.principal, signal);
    const text = result.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    return { result, text };
  };
  const ops = async () =>
    (await readFile(logPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  /** Resolves once the fake helpers have logged `op`. */
  const logged = async (op: string) => {
    for (let attempt = 0; attempt < 250; attempt++) {
      if ((await ops()).includes(op)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`The helper never received ${op}`);
  };
  const close = async () => {
    client.close();
    credentials.close();
    await Promise.all(children.map(exited));
    await rm(dir, { recursive: true, force: true });
  };
  return { client, call, ops, logged, children, exited, close, dir };
}
