import { posix } from "node:path";
import { z } from "zod";
import type { SkillSource } from "@ace/protocol";

/** One `skills` CLI lock entry (`~/.agents/.skill-lock.json`, version 3). Unknown keys are kept. */
const LockEntry = z
  .object({
    source: z.string().max(512),
    sourceType: z.string().max(64),
    sourceUrl: z.string().max(4096),
    ref: z.string().max(256).optional(),
    skillPath: z.string().max(4096),
    skillFolderHash: z.string().max(64),
    updatedAt: z.string().max(64).optional(),
  })
  .passthrough();
const Lock = z
  .object({ version: z.number(), skills: z.record(z.string(), z.unknown()) })
  .passthrough();
export interface LockedSkill extends SkillSource {
  /** Folder inside the repository, from `skillPath`. */
  folder: string;
  ref: string;
}
/** GitHub-installed skills by name. Anything malformed is skipped, never fatal. */
export function readLock(text: string | undefined): Map<string, LockedSkill> {
  const out = new Map<string, LockedSkill>();
  if (!text) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return out;
  }
  const lock = Lock.safeParse(raw);
  if (!lock.success || lock.data.version !== 3) return out;
  for (const [name, value] of Object.entries(lock.data.skills)) {
    const entry = LockEntry.safeParse(value);
    if (!entry.success || entry.data.sourceType !== "github") continue;
    const folder = repositoryFolder(entry.data.skillPath);
    const ref = entry.data.ref ?? "HEAD";
    if (
      !folder ||
      !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(entry.data.sourceUrl)
    )
      continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,255}$/.test(ref) || ref.includes("..")) continue;
    out.set(name, {
      source: entry.data.source,
      url: entry.data.sourceUrl,
      path: entry.data.skillPath,
      folderHash: entry.data.skillFolderHash,
      ...(entry.data.updatedAt ? { updatedAt: entry.data.updatedAt } : {}),
      folder,
      ref,
    });
  }
  return out;
}
/** `skills/x/SKILL.md` -> `skills/x`. Absolute, escaping or odd paths are refused. */
export function repositoryFolder(skillPath: string): string | undefined {
  if (!skillPath.endsWith("SKILL.md") || skillPath.includes("\\") || skillPath.startsWith("/"))
    return undefined;
  const folder = posix.dirname(posix.normalize(skillPath));
  if (
    folder === "." ||
    folder.startsWith("..") ||
    [...folder].some((char) => char.charCodeAt(0) < 32)
  )
    return undefined;
  return folder;
}
/** The lock with one entry's folder hash and time replaced; everything else as it was. */
export function updateLock(text: string, name: string, folderHash: string, at: string): string {
  const lock = Lock.parse(JSON.parse(text));
  const entry = z.record(z.string(), z.unknown()).parse(lock.skills[name]);
  return `${JSON.stringify(
    {
      ...lock,
      skills: { ...lock.skills, [name]: { ...entry, skillFolderHash: folderHash, updatedAt: at } },
    },
    null,
    2,
  )}`;
}
export interface FolderFile {
  hash: string;
  executable: boolean;
}
const plain = /\.(?:md|markdown|mdx|txt)$/i;
/** Added, changed and removed files, with anything runnable or non-text flagged for review. */
export function diffFolders(
  before: ReadonlyMap<string, FolderFile>,
  after: ReadonlyMap<string, FolderFile>,
) {
  const files: { path: string; change: "added" | "changed" | "removed"; flagged: boolean }[] = [];
  const flag = (path: string, file: FolderFile) => file.executable || !plain.test(path);
  for (const [path, file] of after) {
    const old = before.get(path);
    if (!old) files.push({ path, change: "added", flagged: flag(path, file) });
    else if (old.hash !== file.hash || old.executable !== file.executable)
      files.push({ path, change: "changed", flagged: flag(path, file) });
  }
  for (const [path, file] of before)
    if (!after.has(path)) files.push({ path, change: "removed", flagged: flag(path, file) });
  return files.toSorted((a, b) => a.path.localeCompare(b.path));
}
