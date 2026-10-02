import { z } from "zod";
import {
  count,
  decode,
  fieldsAndPath,
  hash,
  hashSchema,
  malformed,
  modeSchema,
  nul,
  pathSchema,
  Records,
  refSchema,
} from "./decode.ts";
import type { RepositoryInfo, Status, StatusEntry } from "./types.ts";

const xySchema = z.string().regex(/^[.MTADRC]{2}$/);
const subSchema = z.string().regex(/^(?:N\.\.\.|S[.C][.M][.U])$/);
const ordinary = z.tuple([
  z.literal("1"),
  xySchema,
  subSchema,
  modeSchema,
  modeSchema,
  modeSchema,
  hashSchema,
  hashSchema,
]);
const renamed = z.tuple([
  z.literal("2"),
  xySchema,
  subSchema,
  modeSchema,
  modeSchema,
  modeSchema,
  hashSchema,
  hashSchema,
  z.string().regex(/^[RC]\d+$/),
]);
const conflict = z.tuple([
  z.literal("u"),
  z.enum(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]),
  subSchema,
  modeSchema,
  modeSchema,
  modeSchema,
  modeSchema,
  hashSchema,
  hashSchema,
  hashSchema,
]);

export function parseStatus(buffer: Buffer): {
  status: Status;
  branch: Omit<RepositoryInfo, "root" | "remotes">;
} {
  const status: Status = { staged: [], unstaged: [], untracked: [], conflicted: [] };
  const branch: Omit<RepositoryInfo, "root" | "remotes"> = {
    branch: null,
    detached: false,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
  };
  const records = new Records(nul(buffer));
  const headers = new Set<string>();
  while (!records.done()) {
    const record = records.next();
    if (record.startsWith("# ")) {
      const space = record.indexOf(" ", 2);
      if (space < 0) throw malformed("status header");
      const key = record.slice(2, space);
      const value = record.slice(space + 1);
      if (headers.has(key)) throw malformed("duplicate status header");
      headers.add(key);
      switch (key) {
        case "branch.oid":
          branch.head = value === "(initial)" ? null : hash(value);
          break;
        case "branch.head":
          branch.detached = value === "(detached)";
          branch.branch = branch.detached ? null : decode(refSchema, value, "branch");
          break;
        case "branch.upstream":
          branch.upstream = decode(refSchema, value, "upstream");
          break;
        case "branch.ab": {
          const [a, b] = decode(
            z.tuple([z.string().regex(/^\+\d+$/), z.string().regex(/^-\d+$/)]),
            value.split(" "),
            "ahead/behind",
          );
          branch.ahead = count(a.slice(1));
          branch.behind = count(b.slice(1));
          break;
        }
        default:
          throw malformed("status header");
      }
    } else if (record.startsWith("? ")) {
      status.untracked.push(decode(pathSchema, record.slice(2), "untracked path"));
    } else {
      const kind = record[0];
      if (kind !== "1" && kind !== "2" && kind !== "u") throw malformed("status record kind");
      const parsed = fieldsAndPath(record, kind === "1" ? 8 : kind === "2" ? 9 : 10);
      let xy: string;
      let submodule: string;
      if (kind === "1") [, xy, submodule] = decode(ordinary, parsed.fields, "ordinary status");
      else if (kind === "2") {
        const data = decode(renamed, parsed.fields, "rename status");
        [, xy, submodule] = data;
        if (!xy.includes(data[8][0] ?? "") || count(data[8].slice(1)) > 100)
          throw malformed("rename score");
      } else [, xy, submodule] = decode(conflict, parsed.fields, "conflict status");
      const [indexStatus, worktreeStatus] = decode(
        z.tuple([z.string().length(1), z.string().length(1)]),
        [...xy],
        "XY status",
      );
      const entry: StatusEntry = { path: parsed.path, indexStatus, worktreeStatus, submodule };
      if (kind === "2") entry.oldPath = decode(pathSchema, records.next(), "rename source");
      if (kind === "u") status.conflicted.push(entry);
      else {
        if (indexStatus !== ".") status.staged.push(entry);
        if (worktreeStatus !== ".") status.unstaged.push(entry);
      }
    }
  }
  if (!headers.has("branch.oid") || !headers.has("branch.head"))
    throw malformed("missing branch headers");
  return { status, branch };
}
