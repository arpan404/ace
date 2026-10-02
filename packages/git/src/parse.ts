import {
  GitError,
  type DiffEntry,
  type RepositoryInfo,
  type Status,
  type StatusEntry,
  type Worktree,
} from "./types.ts";

export function nul(buffer: Buffer): string[] {
  const records = buffer.toString("utf8").split("\0");
  if (records.at(-1) === "") records.pop();
  return records;
}

export function parseWorktrees(buffer: Buffer): Worktree[] {
  const trees: Worktree[] = [];
  let tree: Worktree | undefined;
  for (const record of nul(buffer)) {
    if (record.startsWith("worktree ")) {
      tree = {
        path: record.slice(9),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: null,
        prunable: null,
      };
      trees.push(tree);
    } else if (tree) {
      if (record.startsWith("HEAD "))
        tree.head = /^0+$/.test(record.slice(5)) ? null : record.slice(5);
      if (record.startsWith("branch ")) tree.branch = record.slice(7).replace(/^refs\/heads\//, "");
      if (record === "detached") tree.detached = true;
      if (record === "bare") tree.bare = true;
      if (record === "locked" || record.startsWith("locked ")) tree.locked = record.slice(7);
      if (record === "prunable" || record.startsWith("prunable ")) tree.prunable = record.slice(9);
    }
  }
  return trees;
}

export function parseStatus(buffer: Buffer): {
  status: Status;
  branch: Omit<RepositoryInfo, "root" | "remotes">;
} {
  const status: Status = { staged: [], unstaged: [], untracked: [], conflicted: [] };
  const branch = {
    branch: null as string | null,
    detached: false,
    head: null as string | null,
    upstream: null as string | null,
    ahead: 0,
    behind: 0,
  };
  const records = nul(buffer);
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.startsWith("# branch.oid ")) {
      const value = record.slice(13);
      branch.head = value === "(initial)" ? null : value;
    } else if (record.startsWith("# branch.head ")) {
      const value = record.slice(14);
      branch.detached = value === "(detached)";
      branch.branch = branch.detached ? null : value;
    } else if (record.startsWith("# branch.upstream ")) {
      branch.upstream = record.slice(18);
    } else if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) {
        branch.ahead = Number(match[1]);
        branch.behind = Number(match[2]);
      }
    } else if (record.startsWith("? ")) {
      status.untracked.push(record.slice(2));
    } else if (["1", "2", "u"].includes(record[0] ?? "")) {
      const count = record[0] === "1" ? 8 : record[0] === "2" ? 9 : 10;
      let start = 0;
      for (let field = 0; field < count; field++) start = record.indexOf(" ", start) + 1;
      const fields = record.slice(0, start - 1).split(" ");
      const entry: StatusEntry = {
        path: record.slice(start),
        indexStatus: fields[1]![0]!,
        worktreeStatus: fields[1]![1]!,
        submodule: fields[2]!,
      };
      if (record[0] === "2") entry.oldPath = records[++i]!;
      if (record[0] === "u") status.conflicted.push(entry);
      else {
        if (entry.indexStatus !== ".") status.staged.push(entry);
        if (entry.worktreeStatus !== ".") status.unstaged.push(entry);
      }
    }
  }
  return { status, branch };
}

export function parseRemotes(buffer: Buffer): RepositoryInfo["remotes"] {
  const remotes = new Map<string, RepositoryInfo["remotes"][number]>();
  for (const record of nul(buffer)) {
    const separator = record.indexOf("\n");
    const key = record.slice(0, separator);
    const match = /^remote\.(.+)\.(url|pushurl)$/.exec(key);
    if (!match) continue;
    const name = match[1]!;
    const remote = remotes.get(name) ?? { name, fetchUrls: [], pushUrls: [] };
    remote[match[2] === "url" ? "fetchUrls" : "pushUrls"].push(record.slice(separator + 1));
    remotes.set(name, remote);
  }
  for (const remote of remotes.values()) {
    if (!remote.pushUrls.length) remote.pushUrls = [...remote.fetchUrls];
  }
  return [...remotes.values()];
}

export function parseDiff(buffer: Buffer): DiffEntry[] {
  const records = nul(buffer);
  const entries: DiffEntry[] = [];
  const byPath = new Map<string, DiffEntry>();
  let i = 0;
  while (records[i]?.startsWith(":")) {
    const status = records[i++]!.split(" ").at(-1)![0] as DiffEntry["status"];
    const firstPath = records[i++]!;
    const renamed = status === "R" || status === "C";
    const entry: DiffEntry = {
      path: renamed ? records[i++]! : firstPath,
      status,
      additions: 0,
      deletions: 0,
      binary: false,
    };
    if (renamed) entry.oldPath = firstPath;
    entries.push(entry);
    byPath.set(JSON.stringify([entry.oldPath ?? "", entry.path]), entry);
  }
  while (i < records.length) {
    const record = records[i++]!;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    const additions = record.slice(0, firstTab);
    const deletions = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    let oldPath = "";
    if (!path) {
      oldPath = records[i++]!;
      path = records[i++]!;
    }
    const entry = byPath.get(JSON.stringify([oldPath, path]));
    if (!entry) throw new GitError("git_failed", "Unexpected Git diff metadata");
    entry.binary = additions === "-" || deletions === "-";
    entry.additions = entry.binary ? 0 : Number(additions);
    entry.deletions = entry.binary ? 0 : Number(deletions);
  }
  return entries;
}
