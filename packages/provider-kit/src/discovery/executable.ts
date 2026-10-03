import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, delimiter, isAbsolute, resolve } from "node:path";
async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Resolve directly, without a shell or a platform-specific `which` subprocess. */
export async function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    const path = resolve(command);
    return (await executable(path)) ? path : undefined;
  }
  const candidates = (env["PATH"] ?? "")
    .split(delimiter)
    .map((directory) => resolve(directory, command));
  const found = await Promise.all(candidates.map(executable));
  return candidates.find((_, index) => found[index]);
}

/** A package runner cannot establish an already installed, offline agent binding. */
export function isPackageRunner(path: string): boolean {
  return /^(?:npx|uvx|bunx|npm|pnpm|yarn|bun|uv)(?:-cli)?(?:\.(?:cmd|js|cjs|mjs))?$/.test(
    basename(path),
  );
}
