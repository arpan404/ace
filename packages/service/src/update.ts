import { existsSync } from "node:fs";
import { mkdir, readFile, rm, cp, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  InstalledRelease,
  MaintenanceStatus,
  ReleaseDirectory,
  ReleaseVersion,
} from "@ace/protocol";
import { downloadArchive, unpackArchive, verifyManifest } from "./artifact.ts";
import {
  atomicPointer,
  releasePointer,
  durableJson,
  durableRemove,
  syncTree,
  syncDirectory,
  withInstallLock,
} from "./files.ts";
import { snapshotDatabases, restoreDatabases } from "./migration.ts";
import type { Fetcher } from "./feed.ts";
const Journal = z
  .object({
    old: ReleaseDirectory,
    candidate: ReleaseDirectory,
    version: ReleaseVersion,
    stage: z.enum(["prepared", "snapshotted"]).default("snapshotted"),
  })
  .refine((journal) => journal.old !== journal.candidate, "Recovery generations must differ");
export interface UpdatePorts {
  maintenance(method: "GET" | "POST" | "DELETE"): Promise<unknown>;
  stop(): Promise<void>;
  start(): Promise<void>;
  health(version: string): Promise<boolean>;
  migrate(candidate: string, copy: string): Promise<void>;
  wait(): Promise<void>;
  now(): number;
}
export interface UpdateRequest {
  root: string;
  dataDir: string;
  bytes: Uint8Array;
  signature: string;
  publicKey: string;
  archiveUrl: string;
  fetcher: Fetcher;
  ports: UpdatePorts;
  drain: boolean;
}
async function acquire(ports: UpdatePorts, drain: boolean) {
  const until = ports.now() + 300_000;
  let status = MaintenanceStatus.parse(await ports.maintenance("POST"));
  while (status.blockers > 0) {
    if (!drain || ports.now() >= until) throw new Error("Active threads block update");
    await ports.wait();
    status = MaintenanceStatus.parse(await ports.maintenance("GET"));
    if (!status.draining) throw new Error("Maintenance lease lost");
  }
  if (!status.draining) throw new Error("Maintenance lease required");
}
async function rollback(
  root: string,
  dataDir: string,
  ports: UpdatePorts,
  journal: z.infer<typeof Journal>,
) {
  await ports.stop();
  if (journal.stage === "snapshotted") await restoreDatabases(dataDir, join(root, ".rollback-db"));
  await atomicPointer(join(root, "current"), journal.old);
  await ports.start();
  if (!(await ports.health(journal.version)))
    throw new Error("Rollback health check failed; recovery journal retained");
  await durableRemove(join(root, "update.json"));
  await rm(join(root, journal.candidate), { recursive: true, force: true });
  await rm(join(root, ".rollback-db"), { recursive: true, force: true });
}
export async function recoverUpdate(
  root: string,
  dataDir: string,
  ports: UpdatePorts,
): Promise<boolean> {
  let journal: z.infer<typeof Journal>;
  try {
    journal = Journal.parse(JSON.parse(await readFile(join(root, "update.json"), "utf8")));
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return false;
    throw e;
  }
  // Every journaled candidate starts behind the persistent admission barrier.
  await rollback(root, dataDir, ports, journal);
  return true;
}
export async function applyUpdate(request: UpdateRequest): Promise<"updated"> {
  const { root, dataDir, ports } = request;
  const manifest = verifyManifest(request.bytes, request.signature, request.publicKey);
  return withInstallLock<"updated">(root, async () => {
    let stopped = false;
    let ownsJournal = false;
    try {
      await recoverUpdate(root, dataDir, ports);
      const old = await releasePointer(root);
      const oldManifest = InstalledRelease.parse(
        JSON.parse(await readFile(join(root, old, "release.json"), "utf8")),
      );
      if (manifest.target !== oldManifest.target || manifest.channel !== oldManifest.channel)
        throw new Error("Installed target/channel mismatch");
      if (!isNewer(manifest.version, oldManifest.version)) throw new Error("Release is not newer");
      const candidate = `releases/${manifest.version}-${manifest.target}`;
      const staging = join(root, ".candidate");
      const archive = join(root, ".download.tar.gz");
      await rm(staging, { recursive: true, force: true });
      await rm(archive, { force: true });
      await downloadArchive(
        await request.fetcher(request.archiveUrl, { signal: AbortSignal.timeout(120_000) }),
        archive,
        manifest,
      );
      await unpackArchive(archive, staging);
      await durableJson(join(staging, "release.json"), manifest);
      await acquire(ports, request.drain);
      // Persist intent before stopping. A partial snapshot must never replace live data.
      let journal = Journal.parse({
        old,
        candidate,
        version: oldManifest.version,
        stage: "prepared",
      });
      await durableJson(join(root, "update.json"), journal);
      ownsJournal = true;
      await ports.stop();
      stopped = true;
      const snapshot = join(root, ".rollback-db"),
        check = join(root, ".migration-check");
      await rm(snapshot, { recursive: true, force: true });
      await rm(check, { recursive: true, force: true });
      await snapshotDatabases(dataDir, snapshot);
      await syncTree(snapshot);
      journal = { ...journal, stage: "snapshotted" };
      await durableJson(join(root, "update.json"), journal);
      await cp(snapshot, check, { recursive: true });
      await ports.migrate(staging, check);
      await mkdir(join(root, "releases"), { recursive: true });
      await syncTree(staging);
      await rename(staging, join(root, candidate));
      await syncDirectory(join(root, "releases"));
      await atomicPointer(join(root, "previous"), old);
      await atomicPointer(join(root, "current"), candidate);
      await ports.start();
      stopped = false;
      if (!(await ports.health(manifest.version))) throw new Error("Candidate health check failed");
      await durableRemove(join(root, "update.json"));
      // Bound retained artifacts to current and previous after successful health.
      const { readdir } = await import("node:fs/promises");
      for (const name of await readdir(join(root, "releases")))
        if (`releases/${name}` !== old && `releases/${name}` !== candidate)
          await rm(join(root, "releases", name), { recursive: true, force: true });
      await rm(snapshot, { recursive: true, force: true });
      return "updated";
    } catch (error) {
      if (ownsJournal && existsSync(join(root, "update.json")))
        await recoverUpdate(root, dataDir, ports);
      else if (stopped) await ports.start();
      throw error;
    } finally {
      if (!existsSync(join(root, "update.json"))) await ports.maintenance("DELETE").catch(() => {});
      await rm(join(root, ".download.tar.gz"), { force: true });
      await rm(join(root, ".candidate"), { recursive: true, force: true });
      await rm(join(root, ".migration-check"), { recursive: true, force: true });
    }
  });
}
const numericVersion = (v: string) => v.split("-")[0]?.split(".").map(Number) ?? [];
export function isNewer(next: string, current: string): boolean {
  const n = numericVersion(next),
    c = numericVersion(current);
  for (let i = 0; i < 3; i++) {
    if (n[i] !== c[i]) return (n[i] ?? 0) > (c[i] ?? 0);
  }
  return !next.includes("-") && current.includes("-");
}
