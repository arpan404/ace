import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  antigravityIdentity,
  assertManagedHome,
  createInstance,
  createManagedAcpInstance,
  type AccountRegistry,
} from "@ace/accounts";
import {
  AccountId,
  NativeAccountProvider,
  ProviderInstance,
  type ManagedAccountProvider,
} from "@ace/protocol/accounts";

/** The person's normal Codex home: `CODEX_HOME`, else `~/.codex`. */
export function defaultCodexHome(env: NodeJS.ProcessEnv): string {
  const user = env.HOME ?? env.USERPROFILE;
  if (!user) throw new Error("CLI home unavailable");
  return resolve(env.CODEX_HOME ?? join(user, ".codex"));
}

/** Account metadata points to the normal CLI home; admission never creates that home. */
export async function registerImplicitAccounts(
  registry: AccountRegistry,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const user = env.HOME ?? env.USERPROFILE;
  if (!user) throw new Error("CLI home unavailable");
  const homes = {
    codex: defaultCodexHome(env),
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

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

const unsafeHome = () => new Error("Unsafe OpenCode home");

/**
 * The directory handle for a folder that is the real path just inspected, never a symlink and
 * never a swap: the handle's inode must be the one lstat saw, and its real path must be its path.
 */
async function openDirectory(dir: string, platform: NodeJS.Platform) {
  const before = await lstat(dir);
  if (!before.isDirectory() || before.isSymbolicLink()) throw unsafeHome();
  if ((await realpath(dir)) !== dir) throw unsafeHome();
  // Windows has no O_NOFOLLOW/O_DIRECTORY; the checks above still hold, only modes are skipped.
  const flags =
    platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const handle = await open(dir, flags);
  try {
    const held = await handle.stat();
    if (!held.isDirectory() || held.dev !== before.dev || held.ino !== before.ino)
      throw unsafeHome();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * OpenCode needs to create its log and database under `data/opencode`. A folder that lost its
 * owner's search bit fails every OpenCode command with EACCES, so ace restores it. Each folder is
 * opened without following links and changed through its handle, so a swap mid-repair is refused.
 */
export async function prepareOpenCodeHome(
  homeDir: string,
  platform: NodeJS.Platform,
): Promise<void> {
  // The home itself must be the canonical path: a linked home is someone else's folder.
  if ((await realpath(homeDir).catch(() => undefined)) !== homeDir) throw unsafeHome();
  for (const name of ["data", "config", "state"]) {
    for (const dir of [join(homeDir, name), join(homeDir, name, "opencode")]) {
      let handle: FileHandle;
      try {
        handle = await openDirectory(dir, platform);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        try {
          await mkdir(dir, { mode: 0o700 });
        } catch (createError) {
          // Another repair may have created it first; fall through and verify that folder.
          if (errorCode(createError) !== "EEXIST") throw createError;
        }
        handle = await openDirectory(dir, platform);
      }
      try {
        if (platform !== "win32") {
          const held = await handle.stat();
          if ((held.mode & 0o700) !== 0o700) await handle.chmod((held.mode | 0o700) & 0o7777);
        }
      } finally {
        await handle.close();
      }
    }
  }
}

export async function createManagedHome(
  dataDir: string,
  id: string,
  provider: ManagedAccountProvider,
  label: string,
  platform: NodeJS.Platform,
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
  if (provider === "opencode") await prepareOpenCodeHome(homeDir, platform);
  // Cursor's SDK is the one CLI that still runs with a private HOME (its login follows
  // os.homedir()); every other account uses the person's own home.
  if (provider === "cursor") await mkdir(join(homeDir, "user"), { mode: 0o700 });
  // An added Antigravity account is an ACP account of ace's Antigravity installation.
  if (provider === "antigravity")
    return createManagedAcpInstance({ id, identity: antigravityIdentity, label, homeDir });
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
