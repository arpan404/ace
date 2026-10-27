import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { logFields } from "@ace/diagnostics";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { resolveShell } from "@ace/terminal";
import type { Store } from "../store.ts";
import type { Engine } from "../engine/index.ts";
import { ManagedWorktrees } from "../managed-worktrees.ts";
import { TargetRefusal } from "./target-refusal.ts";
import type { GuestSessions } from "./guest-sessions.ts";
import type { TargetThreads } from "./target-threads.ts";
import { CommandHost } from "./command-host.ts";
import { shellInvocation } from "./command-rules.ts";

/** The real path of a folder, or undefined when nothing (or a file) is there. */
async function folder(path: string): Promise<string | undefined> {
  try {
    const real = await realpath(path);
    return (await stat(real)).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The commands host with this machine's edges: its projects and the worktrees ace made for them,
 * the account's shell (as the terminal picks it), supervised process trees and real timers.
 */
export function commandHost(deps: {
  store: Store;
  engine(): Engine | undefined;
  guests: GuestSessions;
  threads: TargetThreads;
  dataDir: string;
  now(): number;
  log: { log(level: "info", message: string, fields: ReturnType<typeof logFields>): void };
}): CommandHost {
  const worktrees = new ManagedWorktrees(deps.store, deps.dataDir);
  return new CommandHost({
    store: deps.store,
    engine: deps.engine,
    guests: deps.guests,
    roots(project) {
      const path = deps.store.getWorkspacePath(deps.threads.project(project));
      if (!path) throw new TargetRefusal("invalid", "That project has no folder here.");
      return [path, ...worktrees.list().flatMap((tree) => (tree.repo === path ? [tree.path] : []))];
    },
    folder,
    shell: (command) => shellInvocation(process.platform, resolveShell(), command),
    env: () => process.env,
    spawn: (spec) =>
      spawnRawSupervised({ ...spec, name: "machine-command", killGroupOnExit: true }),
    clock: {
      now: deps.now,
      schedule(ms, run) {
        const timer = setTimeout(run, ms);
        timer.unref();
        return () => clearTimeout(timer);
      },
    },
    newId: randomUUID,
    log: (message, fields) => deps.log.log("info", message, logFields(Object.entries(fields))),
  });
}
