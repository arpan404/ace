import type { Capabilities, ExecutionSelection, ThreadId } from "@ace/protocol";
import type { MigrationResult } from "@ace/protocol/accounts";
import type { ThreadState } from "@ace/core";
import type { EngineRepository } from "./repository.ts";
import type { NativeFork } from "./transition-state.ts";
import { planCrossProvider, type CrossProviderPlan } from "./provider-return.ts";
import type { z } from "zod";

/*
 * How a thread continues on another account of the same provider (ADR 0018, 2026-10-19
 * amendment). A native copy keeps the whole session, so it is tried first. When the provider or
 * either login can't be copied, the destination resumes the session it left on this thread with
 * what happened since, or starts fresh with the conversation handoff. A copy the accounts service
 * refuses for safety fails the switch and leaves the source binding untouched.
 */

export type AccountRoute =
  /** Nothing native to carry: the destination opens fresh with any waiting handoff. */
  | { kind: "rebind" }
  /** The session was copied into the destination home and resumes there. */
  | { kind: "copied"; nativeSessionId: string; fork?: z.infer<typeof NativeFork> }
  /** The destination resumes its own earlier session, or opens fresh, with a handoff. */
  | { kind: "handoff"; plan: CrossProviderPlan };

export async function routeAccountChange(
  repo: EngineRepository,
  id: ThreadId,
  args: {
    from: ExecutionSelection;
    to: ExecutionSelection;
    nativeSessionId: string | undefined;
    state: ThreadState;
    capabilities: Capabilities;
    backend: string | undefined;
    budget: number;
    /** Called only when a native session exists and the provider can resume a copy. */
    migrate(request: {
      nativeSessionId: string;
      from: string;
      to: string;
    }): Promise<MigrationResult>;
  },
): Promise<AccountRoute> {
  const { from, to, nativeSessionId, capabilities } = args;
  if (!nativeSessionId) return { kind: "rebind" };
  if (!to.instanceId) throw new Error("Account changes require a destination account");
  if (from.instanceId && capabilities.resume) {
    const migration = await args.migrate({
      nativeSessionId,
      from: from.instanceId,
      to: to.instanceId,
    });
    if (migration.status === "refused") throw new Error(migration.reason);
    if (migration.status === "migrated") {
      if (migration.cleanupWarnings?.includes("lease_release_failed"))
        throw new Error("Migration lease release failed");
      return {
        kind: "copied",
        ...copiedSession(migration.nativeSessionId, migration.action, args),
      };
    }
  }
  return {
    kind: "handoff",
    plan: planCrossProvider(repo, id, {
      from,
      to,
      resumable: capabilities.resume,
      backend: args.backend,
      budget: args.budget,
    }),
  };
}

function copiedSession(
  nativeSessionId: string,
  action: "fork" | "resume",
  args: { state: ThreadState; capabilities: Capabilities },
): { nativeSessionId: string; fork?: z.infer<typeof NativeFork> } {
  if (action === "resume") return { nativeSessionId };
  const { capabilities, state } = args;
  if (capabilities.fork && capabilities.forkPoints?.includes("end"))
    return {
      nativeSessionId,
      fork: { nativeSessionId, point: { type: "end", nativeId: nativeSessionId } },
    };
  const root = state.agents[state.rootKey ?? ""];
  const run = root?.lastRun ? state.runs[root.lastRun] : undefined;
  if (!capabilities.fork || !(capabilities.forkPoints ?? []).includes("turn") || !run?.nativeId)
    throw new Error("Migrated session requires an unsupported native fork boundary");
  return {
    nativeSessionId,
    fork: { nativeSessionId, point: { type: "turn", nativeId: run.nativeId } },
  };
}
