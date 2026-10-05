import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AccountEnvKey, ProviderInstance } from "@ace/protocol/accounts";
import { canonicalHome } from "./paths.ts";
import { createInstance, instanceEnv } from "./instances.ts";

/** Validate directory identities without inspecting any provider credential files. */
export async function assertManagedIdentity(input: ProviderInstance): Promise<void> {
  const instance = ProviderInstance.parse(input);
  if (!instance.managed) return;
  const expected = createInstance(instance).env;
  if (AccountEnvKey.options.some((key) => expected[key] !== instance.env[key]))
    throw new Error("Managed home selectors cannot change");
  const env = instanceEnv(instance, {});
  const directories = new Set([
    instance.homeDir,
    ...Object.values(instance.env),
    ...[
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "XDG_DATA_HOME",
      "XDG_CONFIG_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
      "TMPDIR",
      "TMP",
      "TEMP",
    ].flatMap((key) => env[key] ?? []),
    ...(instance.provider === "cursor" ? [join(instance.homeDir, "user", ".cursor", "sdk")] : []),
  ]);
  for (const path of directories)
    if (resolve(path) !== path || (await canonicalHome(path)) !== path)
      throw new Error("Managed home identity changed");
}

/** Only direct private children of the daemon's injected data root are managed homes. */
export async function assertManagedHome(dataDir: string, input: ProviderInstance): Promise<void> {
  const instance = ProviderInstance.parse(input);
  const parent = join(await realpath(dataDir), "account-homes");
  const expected = join(parent, instance.id);
  if (!instance.managed || instance.implicit || instance.homeDir !== expected)
    throw new Error("Managed home refused");
  for (const path of [parent, expected]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error("Managed home refused");
  }
  await assertManagedIdentity(instance);
}
