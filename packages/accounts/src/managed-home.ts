import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { AccountEnvKey, ProviderInstance } from "@ace/protocol/accounts";
import { canonicalHome } from "./paths.ts";
import { createInstance } from "./instances.ts";
import { managedAcpSelectors } from "./acp-managed-home.ts";

/** Validate directory identities without inspecting any provider credential files. */
async function assertHomeIdentity(input: ProviderInstance): Promise<void> {
  const instance = ProviderInstance.parse(input);
  const expected =
    instance.provider === "acp" ? managedAcpSelectors(instance) : createInstance(instance).env;
  if (AccountEnvKey.options.some((key) => expected[key] !== instance.env[key]))
    throw new Error("Managed home selectors cannot change");
  const directories = new Set([
    instance.homeDir,
    ...Object.values(instance.env),
    ...(instance.provider === "cursor"
      ? [join(instance.homeDir, "user"), join(instance.homeDir, "user", ".cursor", "sdk")]
      : []),
  ]);
  for (const path of directories)
    if (resolve(path) !== path || (await canonicalHome(path)) !== path)
      throw new Error("Managed home identity changed");
}

/** Only direct private children of the daemon's injected data root are managed homes. */
async function managedHomePaths(dataDir: string, input: ProviderInstance) {
  const instance = ProviderInstance.parse(input);
  const root = await lstat(resolve(dataDir));
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Managed home refused");
  const parent = join(await realpath(dataDir), "account-homes");
  const expected = join(parent, instance.id);
  if (!instance.managed || instance.implicit) throw new Error("Managed home refused");
  // Another data root's managed account belongs to that home, not this one.
  if (instance.homeDir !== expected)
    throw new Error(
      basename(dirname(instance.homeDir)) === "account-homes"
        ? "foreign_home"
        : "Managed home refused",
    );
  return [parent, expected];
}

export async function assertManagedHome(
  dataDir: string,
  instance: ProviderInstance,
): Promise<void> {
  for (const path of await managedHomePaths(dataDir, instance)) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error("Managed home refused");
  }
  await assertHomeIdentity(instance);
}

/** Explicit sign-in may recreate a missing home, but never follows a changed identity. */
export async function restoreCursorHome(
  dataDir: string,
  instance: ProviderInstance,
): Promise<boolean> {
  if (instance.provider !== "cursor" || instance.implicit)
    throw new Error("Cursor account required");
  const paths = instance.managed ? await managedHomePaths(dataDir, instance) : [instance.homeDir];
  await assertHomeIdentity(instance);
  let created = false;
  for (const path of [...paths, join(instance.homeDir, "user")]) {
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Account home refused");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await mkdir(path, { recursive: !instance.managed, mode: 0o700 });
      created = true;
    }
  }
  if (instance.managed) await assertManagedHome(dataDir, instance);
  else await assertHomeIdentity(instance);
  return created;
}
