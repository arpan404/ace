import type { MigrationLease, MigrationRequest, MigrationSafety } from "@ace/accounts";
import type { DiscoveryOptions } from "@ace/provider-kit/discovery";
import type { CodexThreadLease, ThreadLeaseOptions } from "@ace/adapter-codex/thread-lease";
import { accountExecutable, type AccountConfiguration } from "./account-executable.ts";

export type HoldCodexThread = (options: ThreadLeaseOptions) => Promise<CodexThreadLease>;

const busy =
  "Codex has this conversation open somewhere else. Close it there, then switch accounts again.";

/**
 * The writer locks ace can hold while it copies a session between accounts. Codex's own CLI holds
 * the thread for the source account; while it does, nothing else can write it, in ace or outside.
 * Providers without such a lock hand the conversation over instead of copying.
 */
export function providerMigrationSafety(options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal: AbortSignal;
  discovery?: DiscoveryOptions | undefined;
  configuration?: AccountConfiguration | undefined;
  hold?: HoldCodexThread;
}): MigrationSafety {
  return {
    async acquire(request: MigrationRequest): Promise<MigrationLease> {
      if (request.provider !== "codex")
        return {
          status: "unsupported",
          reason: "This provider has no writer lock ace can hold while copying",
        };
      const { executable, env } = await accountExecutable(request.from, "codex", options);
      if (!executable)
        return { status: "unsupported", reason: "Codex isn't installed for the source account" };
      const hold =
        options.hold ?? (await import("@ace/adapter-codex/thread-lease")).holdCodexThread;
      let lease: CodexThreadLease;
      try {
        lease = await hold({
          executable,
          env,
          cwd: options.cwd,
          signal: options.signal,
          threadId: request.nativeSessionId,
        });
      } catch (error) {
        // A thread Codex never saved has no history to copy; it continues with the conversation.
        if (error instanceof Error && /no rollout found/i.test(error.message))
          return { status: "unsupported", reason: "Codex has no saved history for this thread" };
        throw error;
      }
      return lease.held
        ? { status: "held", release: lease.release }
        : { status: "busy", reason: busy };
    },
  };
}
