import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Every browser session directory under a service's data dir, across threads. */
export async function sessionDirectories(home: string): Promise<string[]> {
  const threads = join(home, "browser", "threads");
  const found: string[] = [];
  for (const thread of await readdir(threads).catch(() => [])) {
    for (const name of await readdir(join(threads, thread)))
      if (name.startsWith("session-")) found.push(join(threads, thread, name));
  }
  return found;
}
