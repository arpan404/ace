import { lstat, mkdir, rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { cursorInstanceHome } from "@ace/adapter-cursor/instance";
import { AccountEnvKey, type ProviderInstance } from "@ace/protocol/accounts";
import { canonicalHome, exists } from "./paths.ts";
import { createInstance } from "./instances.ts";

export interface HomeMigrationNotice {
  instance: string;
  outcome: "moved" | "recreated";
  reason?: "destination_exists" | "unsafe_source" | "cross_device" | "move_refused";
}

/** Recognize only ace-owned layouts, never conventional user CLI homes. */
async function instanceRoot(
  instance: ProviderInstance,
  dataDir: string,
): Promise<string | undefined> {
  const parent = dirname(instance.homeDir);
  if (basename(instance.homeDir) !== instance.id) return;
  const root =
    basename(parent) === "instances" || (instance.managed && basename(parent) === "account-homes")
      ? dirname(parent)
      : basename(parent) === instance.provider && basename(dirname(parent)) === "instances"
        ? dirname(dirname(parent))
        : undefined;
  if (!root) return;
  if (resolve(root) !== resolve(dataDir)) throw new Error("foreign_home");
  return root;
}

/** Startup owns the registry before any provider host is admitted. No credential bytes are read. */
export async function migrateInstanceHome(
  instance: ProviderInstance,
  dataDir: string,
  notice?: (event: HomeMigrationNotice) => void,
): Promise<ProviderInstance> {
  if (instance.implicit || instance.provider === "acp") return instance;
  const root = await instanceRoot(instance, dataDir);
  if (instance.managed || !root) return instance;
  dataDir = await canonicalHome(dataDir);
  const homeDir =
    instance.provider === "cursor"
      ? cursorInstanceHome(dataDir, instance.id)
      : join(dataDir, "instances", instance.id);
  const target = await canonicalHome(homeDir);
  if (target !== homeDir) throw new Error("Canonical instance home must not follow symbolic links");
  if (instance.homeDir === target) return instance;
  // A separately selected environment is a different instance, not an obsolete ace default.
  const expected = createInstance(instance).env;
  if (AccountEnvKey.options.some((key) => expected[key] !== instance.env[key])) return instance;
  const source = resolve(instance.homeDir);
  let reason: HomeMigrationNotice["reason"];
  if (await exists(target)) {
    if (!(await lstat(target)).isDirectory())
      throw new Error("Canonical instance home must be a directory");
    reason = "destination_exists";
  } else if (await exists(source)) {
    const stat = await lstat(source);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await canonicalHome(source)) !== source)
      reason = "unsafe_source";
    else {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      try {
        // Same-filesystem directory rename is atomic. It cannot overwrite a populated directory.
        await rename(source, target);
        notice?.({ instance: instance.id, outcome: "moved" });
      } catch (error) {
        if (!(error instanceof Error && "code" in error)) throw error;
        if (error.code === "EXDEV") reason = "cross_device";
        else if (["EACCES", "EPERM", "EBUSY"].includes(String(error.code))) reason = "move_refused";
        else if (["EEXIST", "ENOTEMPTY"].includes(String(error.code)))
          reason = "destination_exists";
        else throw error;
      }
    }
  }
  if (!(await exists(target))) await mkdir(target, { recursive: true, mode: 0o700 });
  const destination = await lstat(target);
  if (
    !destination.isDirectory() ||
    destination.isSymbolicLink() ||
    (await canonicalHome(target)) !== target
  )
    throw new Error("Canonical instance home changed during migration");
  if (reason) notice?.({ instance: instance.id, outcome: "recreated", reason });
  return { ...instance, ...createInstance({ ...instance, homeDir: target }) };
}
