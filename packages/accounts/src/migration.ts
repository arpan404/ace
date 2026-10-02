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
} from "./migration-files.ts";
import { instanceEnv } from "./instances.ts";

export type MigrationRequest = {
  provider: ProviderInstance["provider"];
  nativeSessionId: string;
  from: ProviderInstance;
  to: ProviderInstance;
};
/**
 * The engine must exclude ALL source/destination writers, including outside ace,
 * and new starts until release. Reject if exclusive quiescence cannot be proven.
 * Holding a lease for only the root is insufficient: fork ancestors/sidechains matter.
 */
export type MigrationSafety = {
  acquire: (request: MigrationRequest) => Promise<{ release: () => Promise<void> } | undefined>;
};
export async function migrateSession(
  request: MigrationRequest,
  safety: MigrationSafety,
): Promise<MigrationResult> {
  let lease: Awaited<ReturnType<MigrationSafety["acquire"]>>;
  let stage: string | undefined;
  const published: string[] = [];
  try {
    const from = ProviderInstance.parse(request.from);
    const to = ProviderInstance.parse(request.to);
    instanceEnv(from, {});
    instanceEnv(to, {});
    if (from.provider !== request.provider || to.provider !== request.provider || from.id === to.id)
      throw new MigrationFailure("refused", "Invalid instance pair");
    if (request.provider === "opencode")
      return {
        status: "unsupported",
        reason:
          "OpenCode export/import does not establish complete child-history fidelity and writer exclusion",
      };
    if (request.provider === "cursor")
      return {
        status: "unsupported",
        reason: "Cursor ACP store portability and resume/fork are not a supported contract",
      };
    const id = NativeSessionId.parse(request.nativeSessionId);
    const sourceHome = await realpath(from.homeDir);
    await mkdir(to.homeDir, { recursive: true, mode: 0o700 });
    const targetHome = await realpath(to.homeDir);
    if (contains(sourceHome, targetHome) || contains(targetHome, sourceHome))
      throw new MigrationFailure("refused", "Instance homes overlap");
    if ((await lstat(from.homeDir)).isSymbolicLink() || (await lstat(to.homeDir)).isSymbolicLink())
      throw new MigrationFailure("refused", "Symlinked instance homes cannot be migrated");
    lease = await safety.acquire({ ...request, from, to, nativeSessionId: id });
    if (!lease)
      throw new MigrationFailure(
        "refused",
        "Source or destination is live, or exclusive quiescence cannot be proven",
      );
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
        if (source.hash !== destination.hash)
          throw new MigrationFailure("refused", "Destination session already exists");
        fingerprints.push(source.fingerprint);
      } else {
        fingerprints.push(await stageFile(file, stage));
        pending.push(file);
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
    await rollback(published);
    return {
      status: error instanceof MigrationFailure ? error.status : "refused",
      reason:
        error instanceof MigrationFailure
          ? error.message
          : "Migration failed validation or filesystem safety checks",
    };
  } finally {
    try {
      if (stage) await rm(stage, { recursive: true, force: true });
    } finally {
      await lease?.release();
    }
  }
}
