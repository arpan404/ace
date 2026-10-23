import { lstat, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { ghConfigDir, gitGlobalFiles, gitHomeCandidates } from "@ace/provider-kit/user-tool-paths";

/**
 * Cursor's SDK finds its login through `os.homedir()`, so its host runs with HOME (and
 * USERPROFILE on Windows) set to ace's private instance home. These helpers point the
 * person's own gh and git back at their real configuration, so tools inside a Cursor
 * session behave as they do in a terminal on macOS, Linux and Windows.
 */
export interface UserToolsInput {
  platform: NodeJS.Platform;
  /** The person's environment, before Cursor's private HOME replaces it. */
  userEnv: NodeJS.ProcessEnv;
  /** The person's home as `os.homedir()` reports it; the last fallback. */
  userHome: string;
}

/** gh follows GH_CONFIG_DIR; an explicit value in the launch environment wins. */
export function userToolEnv(
  input: UserToolsInput & { launch: NodeJS.ProcessEnv },
): NodeJS.ProcessEnv {
  if (input.launch.GH_CONFIG_DIR) return {};
  const gh = ghConfigDir({ platform: input.platform, env: input.userEnv });
  return gh ? { GH_CONFIG_DIR: gh } : {};
}

/** A git config string value: quoted, with backslashes and quotes escaped. */
const quote = (path: string) => `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const isDirectory = (path: string) =>
  stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );

/**
 * Git reads `<HOME>/.gitconfig`, which is the private home here. Write that file as an
 * include of the person's two global files, in git's order, so both apply with their usual
 * precedence. When the launch environment sets XDG_CONFIG_HOME, git reads that XDG file
 * itself, so it is not included twice. An explicit GIT_CONFIG_GLOBAL replaces both and
 * needs nothing. Writes from `git config --global` land in this private file.
 */
export async function writeGitIncludes(
  input: UserToolsInput & { launch: NodeJS.ProcessEnv; privateHome: string },
): Promise<void> {
  const { platform, userEnv, launch } = input;
  const target = join(input.privateHome, ".gitconfig");
  if (launch.GIT_CONFIG_GLOBAL) return;
  const candidates = gitHomeCandidates({ platform, env: userEnv });
  let home = candidates.length === 1 ? candidates[0] : undefined;
  for (const candidate of candidates) if (!home && (await isDirectory(candidate))) home = candidate;
  home ??= candidates.at(-1) ?? input.userHome;
  const both = gitGlobalFiles({ platform, env: userEnv, home });
  const files = launch.XDG_CONFIG_HOME ? both.slice(1) : both;
  const content = [
    "# Written by ace: the person's own global git config, read from their real home.",
    "[include]",
    ...files.map((path) => `\tpath = ${quote(path)}`),
    "",
  ].join("\n");
  if ((await readFile(target, "utf8").catch(() => undefined)) === content) return;
  await writeFile(target, content, { mode: 0o600 });
}

/**
 * On macOS the keychain search list is found through HOME, so with Cursor's private HOME
 * `gh` sees the person's account but cannot read its token. Link the private home's
 * `Library/Keychains` to the person's own. Cursor's SDK keeps its login in a file under
 * `.cursor/sdk`, never the keychain, so accounts stay apart. Windows Credential Manager and
 * the Linux secret service do not depend on HOME, so nothing is needed there. A real folder
 * already at that path is left alone.
 */
export async function linkUserKeychains(input: {
  platform: NodeJS.Platform;
  userHome: string;
  privateHome: string;
}): Promise<void> {
  if (input.platform !== "darwin") return;
  const source = posix.join(input.userHome, "Library", "Keychains");
  const link = posix.join(input.privateHome, "Library", "Keychains");
  const existing = await lstat(link).catch(() => undefined);
  if (existing && !existing.isSymbolicLink()) return;
  if (existing) {
    if ((await readlink(link)) === source) return;
    await rm(link);
  }
  await mkdir(posix.dirname(link), { recursive: true, mode: 0o700 });
  await symlink(source, link);
}
