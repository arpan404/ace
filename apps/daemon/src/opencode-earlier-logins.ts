import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { openCodeEarlierLogins } from "@ace/accounts";

/** Where OpenCode kept logins before 2.2: its data home, or an ace-managed home's data dir. */
const files = ["auth.json", join("data", "opencode", "auth.json")];
const maxBytes = 256 * 1024;

/**
 * The integrations an OpenCode home held a pre-2.2 login for, by name only. The file is read
 * and parsed in this call; nothing it holds is kept, logged or sent.
 */
export async function readOpenCodeEarlierLogins(home: string): Promise<ReadonlySet<string>> {
  for (const file of files) {
    const path = join(home, file);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > maxBytes) continue;
      return openCodeEarlierLogins(await readFile(path, "utf8"));
    } catch {
      // No file here: try the next place.
    }
  }
  return new Set();
}
