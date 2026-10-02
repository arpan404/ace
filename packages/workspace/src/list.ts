import type { SafeRoot } from "./safety.ts";
import type { GitIgnore } from "./ignore.ts";
import { tree } from "./tree.ts";
import { integer, WorkspaceError, type ListOptions, type ListResult } from "./types.ts";

export async function list(
  safe: SafeRoot,
  ignore: GitIgnore,
  options: ListOptions,
): Promise<ListResult> {
  const dir = safe.path(options.dir);
  const depth = integer(options.depth ?? 1, "depth", 1, 100);
  const limit = integer(options.limit ?? 500, "limit", 1, 1000);
  const includeIgnored = options.includeIgnored ?? false;
  const key = JSON.stringify([dir, depth, includeIgnored]);
  let skip = 0;
  if (options.cursor !== undefined) {
    try {
      if (options.cursor.length > 8192) throw new Error("oversized");
      const decoded: unknown = JSON.parse(
        Buffer.from(options.cursor, "base64url").toString("utf8"),
      );
      if (!Array.isArray(decoded) || decoded[0] !== key || typeof decoded[1] !== "number")
        throw new Error("mismatch");
      skip = integer(decoded[1], "cursor", 0, 100_000);
    } catch (error) {
      throw new WorkspaceError("INVALID_CURSOR", "Cursor does not match the listing", error);
    }
  }
  const result: ListResult = { entries: [], nextCursor: null, truncated: false };
  let seen = 0;
  for await (const entry of tree(safe, ignore, { dir, depth, includeIgnored })) {
    if (seen++ < skip) continue;
    if (result.entries.length >= limit) {
      result.nextCursor = Buffer.from(JSON.stringify([key, skip + result.entries.length])).toString(
        "base64url",
      );
      result.truncated = true;
      break;
    }
    result.entries.push(entry);
  }
  return result;
}
