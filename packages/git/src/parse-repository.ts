import { z } from "zod";
import { absolutePathSchema, decode, hash, malformed, nul, refSchema } from "./decode.ts";
import type { RepositoryInfo, Worktree } from "./types.ts";

export function parseWorktrees(buffer: Buffer): Worktree[] {
  const trees: Worktree[] = [];
  let tree: Worktree | undefined;
  let fields = new Set<string>();
  const finish = () => {
    if (!tree) throw malformed("empty worktree record");
    if (
      (tree.detached && tree.branch) ||
      (tree.bare && (fields.has("HEAD") || tree.branch || tree.detached))
    )
      throw malformed("contradictory worktree fields");
    if (!tree.bare && (!fields.has("HEAD") || (!tree.detached && !tree.branch)))
      throw malformed("incomplete worktree record");
    trees.push(tree);
    tree = undefined;
    fields = new Set();
  };
  for (const record of nul(buffer)) {
    if (!record) {
      finish();
      continue;
    }
    const separator = record.indexOf(" ");
    const key = separator < 0 ? record : record.slice(0, separator);
    const value = separator < 0 ? "" : record.slice(separator + 1);
    if (fields.has(key)) throw malformed("duplicate worktree field");
    fields.add(key);
    if (key === "worktree") {
      if (tree) throw malformed("worktree separator");
      tree = {
        path: decode(absolutePathSchema, value, "worktree path"),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: null,
        prunable: null,
      };
    } else {
      if (!tree) throw malformed("worktree field order");
      switch (key) {
        case "HEAD":
          tree.head = /^0+$/.test(hash(value)) ? null : value;
          break;
        case "branch":
          tree.branch = decode(refSchema, value, "worktree branch");
          if (!tree.branch.startsWith("refs/heads/")) throw malformed("worktree branch namespace");
          tree.branch = tree.branch.slice(11);
          break;
        case "bare":
          if (value) throw malformed("bare flag");
          tree.bare = true;
          break;
        case "detached":
          if (value) throw malformed("detached flag");
          tree.detached = true;
          break;
        case "locked":
          tree.locked = value;
          break;
        case "prunable":
          tree.prunable = value;
          break;
        default:
          throw malformed("worktree attribute");
      }
    }
  }
  if (tree) throw malformed("unterminated worktree record");
  if (!trees.length) throw malformed("missing worktree records");
  return trees;
}
export function parseRemotes(buffer: Buffer): RepositoryInfo["remotes"] {
  const remotes = new Map<string, RepositoryInfo["remotes"][number]>();
  for (const record of nul(buffer)) {
    const separator = record.indexOf("\n");
    if (separator < 0) throw malformed("remote record arity");
    const match = /^remote\.(.+)\.(url|pushurl)$/.exec(record.slice(0, separator));
    const [name, kind] = decode(
      z.tuple([refSchema, z.enum(["url", "pushurl"])]),
      match?.slice(1),
      "remote key",
    );
    const url = decode(z.string().min(1), record.slice(separator + 1), "remote URL");
    const remote = remotes.get(name) ?? { name, fetchUrls: [], pushUrls: [] };
    remote[kind === "url" ? "fetchUrls" : "pushUrls"].push(url);
    remotes.set(name, remote);
  }
  for (const remote of remotes.values())
    if (!remote.pushUrls.length) remote.pushUrls = [...remote.fetchUrls];
  return [...remotes.values()];
}
