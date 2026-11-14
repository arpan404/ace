import { lstat, readFile, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { textOutput } from "./cli.ts";
import { nul } from "./decode.ts";
import type { IndexEntry } from "./parse-index.ts";
import type { Repository } from "./repository.ts";

/*
 * When a snapshot may start from a copy of the checkout's index and reuse Git's stat cache.
 *
 * The rule: only when Git's stat data, plus the check below, notices every change to a file's
 * content, and the blob recorded for an unchanged file is the one hashing its bytes now would
 * give. Anything else uses the from-scratch seed, which hashes every file.
 *
 * - Stat data must be complete: `core.trustctime=false`, `core.ignoreStat=true` and
 *   `core.checkStat=minimal` each let an edit through, so they fall back. So does a filesystem
 *   not known to keep a real change time (only APFS/HFS+ on macOS and common local Linux
 *   filesystems qualify), and Windows, where Git reads the creation time as ctime.
 * - Git compares whole seconds: an equal-length rewrite in the same second as the recorded
 *   change, with its mtime put back, keeps every stat field. A rewrite always moves the change
 *   time forward, so any entry changed (ctime) since shortly before the index was written has
 *   its stat data dropped and is hashed again.
 * - A content conversion (clean filter, autocrlf, a text/eol/ident/encoding attribute) can make
 *   the recorded blob differ from the bytes, and ace's own snapshots run without the person's
 *   filters and global attributes. Any configured filter driver, autocrlf other than false, or an
 *   attribute source naming a conversion falls back.
 * - fsmonitor, the untracked cache and `core.ignoreStat` are switched off for every command on
 *   the temporary index (see `snapshotConfig`), so none can report a changed or new file as
 *   untouched.
 */

/**
 * Command-scope settings for every Git call on the temporary index: no fsmonitor or untracked
 * cache answers, and no `core.ignoreStat`, which would mark every entry `read-tree` or `add`
 * writes as assume-unchanged, so later edits to it are skipped (from-scratch seed included).
 */
export const snapshotConfig = [
  "'core.fsmonitor'='false'",
  "'core.untrackedCache'='false'",
  "'core.ignoreStat'='false'",
];

/** A rewrite between Git's stat and its index write stays inside this window before the write. */
const changeWindowNs = 5_000_000_000n;

// statfs `type` values for filesystems whose change time moves on every write.
const trustedFilesystems: Partial<Record<NodeJS.Platform, ReadonlySet<number>>> = {
  // APFS and HFS+.
  darwin: new Set([26, 17]),
  // ext2/3/4, XFS, Btrfs, tmpfs, ZFS, F2FS, bcachefs, overlayfs.
  linux: new Set([
    0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x2fc12fc1, 0xf2f52010, 0xca451a4e, 0x794c7630,
  ]),
};

const conversion = /\b(text|eol|crlf|filter|ident|working-tree-encoding)\b/;

interface Settings {
  /** Stat data and the settings around it allow reusing the cache at all. */
  trusted: boolean;
  /** Attribute files outside the checkout that Git may read. */
  attributeFiles: string[];
}

export async function statCacheTrusted(
  repository: Repository,
  root: string,
  entries: readonly IndexEntry[],
  env: Record<string, string>,
): Promise<boolean> {
  const filesystems = trustedFilesystems[repository.cli.platform];
  if (!filesystems) return false;
  try {
    if (!filesystems.has((await statfs(root)).type)) return false;
  } catch {
    return false;
  }
  const settings = await repository.cli.configFact(root, "snapshot-stat-trust", () =>
    readSettings(repository, root),
  );
  if (!settings.trusted) return false;
  const inTree = entries
    .filter((entry) => basename(entry.path) === ".gitattributes")
    .map((entry) => join(root, entry.path));
  const untracked = nul(
    (
      await repository.cli.call(
        root,
        ["ls-files", "-z", "--others", "--exclude-standard", "--", ":(glob)**/.gitattributes"],
        { env },
      )
    ).stdout,
  ).map((path) => join(root, path));
  for (const file of [...settings.attributeFiles, ...inTree, ...untracked]) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      // A tracked attributes file deleted from disk changed the rules; an absent optional one
      // (global, system, info) never applied.
      if (inTree.includes(file)) return false;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      return false;
    }
    if (conversion.test(text)) return false;
  }
  return true;
}

/** Paths whose content may have changed without moving Git's stat data: hash them again. */
export async function recentlyChanged(
  root: string,
  entries: readonly IndexEntry[],
  indexMtimeNs: bigint,
): Promise<IndexEntry[]> {
  const since = indexMtimeNs - changeWindowNs;
  const recent: IndexEntry[] = [];
  for (let start = 0; start < entries.length; start += 256) {
    const batch = entries.slice(start, start + 256);
    const changed = await Promise.all(
      batch.map(async (entry) => {
        try {
          return (await lstat(join(root, entry.path), { bigint: true })).ctimeNs >= since;
        } catch {
          // Gone or replaced by something unreadable: `git add` sees that without stat data.
          return false;
        }
      }),
    );
    for (const [index, entry] of batch.entries()) if (changed[index]) recent.push(entry);
  }
  return recent;
}

async function readSettings(repository: Repository, root: string): Promise<Settings> {
  const { cli } = repository;
  const [config, common, system] = await Promise.all([
    cli.call(
      root,
      [
        "config",
        "-z",
        "--get-regexp",
        "^(core\\.(trustctime|ignorestat|checkstat|autocrlf|attributesfile)|filter\\..*\\.(clean|process))$",
      ],
      { allowFailure: true },
    ),
    cli.call(root, ["rev-parse", "--git-common-dir"]),
    cli.call(root, ["var", "GIT_ATTR_SYSTEM"], { allowFailure: true }),
  ]);
  if (config.exitCode !== 0 && config.exitCode !== 1)
    return { trusted: false, attributeFiles: [] };
  // An unknown system attributes location could hold any rule.
  if (system.exitCode !== 0) return { trusted: false, attributeFiles: [] };
  const values = new Map<string, string>();
  for (const record of nul(config.stdout)) {
    const newline = record.indexOf("\n");
    const key = newline < 0 ? record : record.slice(0, newline);
    // A key with no value is boolean true; the last value Git reads wins.
    values.set(key, newline < 0 ? "true" : record.slice(newline + 1));
    if (key.startsWith("filter.")) return { trusted: false, attributeFiles: [] };
  }
  const flag = (key: string, fallback: boolean): boolean | undefined => {
    const value = values.get(key)?.toLowerCase();
    if (value === undefined) return fallback;
    if (["true", "yes", "on", "1", ""].includes(value)) return true;
    if (["false", "no", "off", "0"].includes(value)) return false;
    return undefined;
  };
  const trusted =
    flag("core.trustctime", true) === true &&
    flag("core.ignorestat", false) === false &&
    (values.get("core.checkstat") ?? "default").toLowerCase() === "default" &&
    flag("core.autocrlf", false) === false;
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const configured = values.get("core.attributesfile");
  const global = configured
    ? configured.startsWith("~/")
      ? join(homedir(), configured.slice(2))
      : resolve(root, configured)
    : join(xdg, "git", "attributes");
  return {
    trusted,
    attributeFiles: [
      global,
      join(resolve(root, textOutput(common)), "info", "attributes"),
      ...(textOutput(system) ? [textOutput(system)] : []),
    ],
  };
}
