import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The token a client on this machine pastes to connect (`ace token`). It is read from the home
 * the daemon actually uses (`config.dataDir`), so it is right whichever home was selected.
 */
export function readLocalToken(dataDir: string): string {
  const path = join(dataDir, "daemon-token");
  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new Error(
        `No daemon token at ${path} yet. Start the daemon with \`ace start\` first.`,
        {
          cause: error,
        },
      );
    throw error;
  }
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`The daemon token at ${path} is not valid.`);
  return token;
}
