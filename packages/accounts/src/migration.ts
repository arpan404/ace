import { mkdtemp, mkdir, realpath, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { ProviderInstance, type MigrationResult } from "@ace/protocol/accounts";
import { codexPlan, claudePlan, checkWriterLocks, NativeSessionId } from "./migration-plan.ts";
import {
  contains,
  exists,
  fingerprint,
  MigrationFailure,
  stageFile,
  publishFile,
  rollback,
  digestFile,
  safeParents,
  type CopyFile,
  type MigrationObserver,
} from "./migration-files.ts";
import { canonicalHome } from "./paths.ts";
import { instanceEnv } from "./instances.ts";

export type MigrationRequest = {
  provider: ProviderInstance["provider"];
  nativeSessionId: string;
  from: ProviderInstance;
  to: ProviderInstance;
};
/**
 * What proves no one else writes the session while it is copied. The provider's own CLI holds its
 * writer lock (Codex resumes the thread on a short-lived app-server), so every writer, inside ace
 * or outside it, is excluded until release. Unrelated sessions on either account keep running.
 */
export type MigrationLease =
  | { status: "held"; release: () => Promise<void> }
  /** Another process has the session open; nothing was copied and a retry may succeed. */
  | { status: "busy"; reason: string }
  /** The provider has no writer lock ace can hold, so its history can't be copied safely. */
  | { status: "unsupported"; reason: string };
export type MigrationSafety = {
  acquire: (request: MigrationRequest) => Promise<MigrationLease>;
};
/** Without a provider lease nothing proves the copy is complete, so the thread hands over. */
export const noMigrationLease: MigrationSafety = {
  acquire: async () => ({
    status: "unsupported",
    reason: "This provider has no writer lock ace can hold while copying",
  }),
};
export async function migrateSession(
  request: MigrationRequest,
  safety: MigrationSafety,
  observe?: MigrationObserver,
): Promise<MigrationResult> {
  const owned: { release?: () => Promise<void> } = {};
  let stage: string | undefined;
  const published: string[] = [];
  const cleanupWarnings: NonNullable<MigrationResult["cleanupWarnings"]> = [];
  let result: MigrationResult;
  const run = async (): Promise<MigrationResult> => {
    try {
      const from = ProviderInstance.parse(request.from);
      const to = ProviderInstance.parse(request.to);
      instanceEnv(from, {});
      instanceEnv(to, {});
      if (
        from.provider !== request.provider ||
        to.provider !== request.provider ||
        from.id === to.id
      )
        throw new MigrationFailure("refused", "Invalid instance pair");
      if (request.provider === "acp")
        return {
          status: "unsupported",
          reason: "ACP migration has no verified CLI-owned strategy",
        };
      if (request.provider === "pi")
        return { status: "unsupported", reason: "Pi native session portability is unverified" };
      if (request.provider === "opencode")
        return {
          status: "unsupported",
          reason:
            "OpenCode export/import does not establish complete child-history fidelity and writer exclusion",
        };
      if (request.provider === "cursor")
        return {
          status: "unsupported",
          reason:
            "Cursor SDK checkpoints cannot migrate accounts; continue through a portable context handoff",
        };
      const id = NativeSessionId.parse(request.nativeSessionId);
      const sourceHome = await realpath(from.homeDir);
      const targetHome = await canonicalHome(to.homeDir);
      if (contains(sourceHome, targetHome) || contains(targetHome, sourceHome))
        throw new MigrationFailure("refused", "Instance homes overlap");
      if (
        (await lstat(from.homeDir)).isSymbolicLink() ||
        ((await exists(to.homeDir)) && (await lstat(to.homeDir)).isSymbolicLink())
      )
        throw new MigrationFailure("refused", "Symlinked instance homes cannot be migrated");
      const lease = await safety.acquire({ ...request, from, to, nativeSessionId: id });
      if (lease.status === "busy") throw new MigrationFailure("refused", lease.reason);
      if (lease.status === "unsupported") throw new MigrationFailure("unsupported", lease.reason);
      owned.release = lease.release;
      await mkdir(to.homeDir, { recursive: true, mode: 0o700 });
      if ((await realpath(to.homeDir)) !== targetHome)
        throw new MigrationFailure("refused", "Destination changed before migration");
      const plan =
        request.provider === "codex"
          ? await codexPlan(sourceHome, id)
          : await claudePlan(sourceHome, id);
      await checkWriterLocks(sourceHome, request.provider, plan.ids);
      await checkWriterLocks(targetHome, request.provider, plan.ids);
      const pending: CopyFile[] = [];
      const fingerprints: string[] = [];
      stage = await mkdtemp(join(targetHome, ".ace-migrate-"));
      for (const file of plan.files) {
        const target = join(targetHome, file.relative);
        if (await exists(target)) {
          await safeParents(targetHome, target);
          const source = await digestFile(file.source);
          const destination = await digestFile(target);
          // A different session under this ID can't be replaced; the thread hands over instead.
          if (source.hash !== destination.hash)
            throw new MigrationFailure("unsupported", "Destination session already exists");
          fingerprints.push(source.fingerprint);
        } else {
          fingerprints.push(await stageFile(file, stage, observe));
          pending.push(file);
          await observe?.({
            phase: "staged",
            source: file.source,
            bytes: (await lstat(file.source)).size,
          });
        }
      }
      await checkWriterLocks(sourceHome, request.provider, plan.ids);
      await checkWriterLocks(targetHome, request.provider, plan.ids);
      for (let index = 0; index < plan.files.length; index++) {
        const file = plan.files[index];
        if (!file || fingerprint(await lstat(file.source)) !== fingerprints[index])
          throw new MigrationFailure("refused", "Source changed during migration");
      }
      for (const file of pending) published.push(await publishFile(stage, targetHome, file));
      return {
        status: "migrated",
        nativeSessionId: id,
        action: plan.action,
        copiedFiles: pending.length,
      };
    } catch (error) {
      try {
        await rollback(published);
      } catch {
        cleanupWarnings.push("rollback_failed");
      }
      return {
        status: error instanceof MigrationFailure ? error.status : "refused",
        reason:
          error instanceof MigrationFailure
            ? error.message
            : "Migration failed validation or filesystem safety checks",
      };
    }
  };
  result = await run();
  try {
    if (stage) await rm(stage, { recursive: true, force: true });
  } catch {
    cleanupWarnings.push("staging_cleanup_failed");
  }
  try {
    await owned.release?.();
  } catch {
    cleanupWarnings.push("lease_release_failed");
  }
  return cleanupWarnings.length ? { ...result, cleanupWarnings } : result;
}
