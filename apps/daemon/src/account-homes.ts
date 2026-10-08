import { mkdir, lstat, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertManagedHome, createInstance, type AccountRegistry } from "@ace/accounts";
import { AccountId, NativeAccountProvider, ProviderInstance } from "@ace/protocol/accounts";

/** Account metadata points to the normal CLI home; admission never creates that home. */
export async function registerImplicitAccounts(
  registry: AccountRegistry,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const user = env.HOME ?? env.USERPROFILE;
  if (!user) throw new Error("CLI home unavailable");
  const homes = {
    codex: env.CODEX_HOME ?? join(user, ".codex"),
    claude: env.CLAUDE_CONFIG_DIR ?? join(user, ".claude"),
    opencode: join(env.XDG_DATA_HOME ?? join(user, ".local", "share"), "opencode"),
    pi: env.PI_CODING_AGENT_DIR ?? join(user, ".pi", "agent"),
  };
  for (const provider of NativeAccountProvider.options) {
    if (provider === "cursor") continue;
    const id = `${provider}-cli-default`;
    const existing = registry.get(id);
    if (existing && !existing.instance.implicit)
      throw new Error("Implicit account identity occupied");
    await registry.register(
      ProviderInstance.parse({
        id,
        provider,
        label: "Your CLI login",
        homeDir: resolve(homes[provider]),
        env: {},
        implicit: true,
      }),
    );
  }
}

export async function createManagedHome(
  dataDir: string,
  id: string,
  provider: ProviderInstance["provider"],
  label: string,
): Promise<ProviderInstance> {
  AccountId.parse(id);
  const root = await realpath(dataDir);
  const parent = join(root, "account-homes");
  await mkdir(parent, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(parent)) !== parent)
    throw new Error("Unsafe account home root");
  const homeDir = join(parent, id);
  await mkdir(homeDir, { mode: 0o700 });
  // Restrict even incidental CLI writes such as caches and browser helpers to this home.
  await mkdir(join(homeDir, "user"), { mode: 0o700 });
  return { ...createInstance({ id, provider, label, homeDir }), managed: true };
}

export async function deleteManagedHome(
  dataDir: string,
  instance: ProviderInstance,
): Promise<void> {
  const parent = join(await realpath(dataDir), "account-homes");
  if (
    !instance.managed ||
    instance.implicit ||
    instance.homeDir !== join(parent, AccountId.parse(instance.id))
  )
    throw new Error("Managed home refused");
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(parent)) !== parent)
    throw new Error("Managed home refused");
  try {
    await lstat(instance.homeDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  await assertManagedHome(dataDir, instance);
  await rm(instance.homeDir, { recursive: true });
}
