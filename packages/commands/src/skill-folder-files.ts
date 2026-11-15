import {
  ContainedPath,
  skillFileLimits,
  type SkillFile,
  type SkillFileOmitted,
} from "@ace/protocol";
import type { SkillDisk } from "./skill-disk.ts";
import { SkillError, sha256 } from "./skill-errors.ts";
import { skillFolderLimits } from "./limits.ts";

/** Omitted entries kept in one answer; the schema's own bound. */
const mostOmitted = 1024;

export interface SkillFolderFiles {
  files: SkillFile[];
  omitted: SkillFileOmitted[];
}

const hidden = (name: string) => name.startsWith(".");

/**
 * A skill's files besides its top SKILL.md, through its pinned folder (ADR 0151). Names are
 * sorted, so the same folder lists the same way. Hidden entries and links are never listed;
 * what is too large, past the file limit, nested too deep or not a regular file is noted in
 * `omitted`. Files past 16 MB in all are noted as too large rather than read.
 */
export async function listSkillFolder(disk: SkillDisk, folder: number): Promise<SkillFolderFiles> {
  const out: SkillFolderFiles = { files: [], omitted: [] };
  const budget = { bytes: 0 };
  const omit = (path: string, reason: SkillFileOmitted["reason"]) => {
    if (out.omitted.length < mostOmitted) out.omitted.push({ path, reason });
  };
  const visit = async (directory: number, prefix: string, depth: number): Promise<void> => {
    const names = (await disk.names(directory)).filter((name) => !hidden(name)).sort();
    for (const name of names) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!prefix && name === "SKILL.md") continue;
      if (!ContainedPath.safeParse(path).success) {
        omit(path, "not_a_file");
        continue;
      }
      const child = await disk.openDirectory(directory, name);
      if (child !== undefined) {
        try {
          if (depth + 1 > skillFolderLimits.depth) omit(path, "too_deep");
          else await visit(child, path, depth + 1);
        } finally {
          await disk.closeDirectory(child);
        }
        continue;
      }
      if (out.files.length >= skillFileLimits.files) {
        omit(path, "too_many");
        continue;
      }
      const entry = await disk.readEntry(directory, name, skillFileLimits.bytes);
      if (entry === undefined) omit(path, "not_a_file");
      else if (
        entry === "too_large" ||
        budget.bytes + entry.bytes.length > skillFolderLimits.totalBytes
      )
        omit(path, "too_large");
      else {
        budget.bytes += entry.bytes.length;
        out.files.push({
          path,
          size: entry.bytes.length,
          hash: sha256(entry.bytes),
          executable: entry.executable,
        });
      }
    }
  };
  await visit(folder, "", 0);
  return out;
}

/** One of a skill's files by its relative path, never through a link or a hidden entry. */
export async function readSkillFolderFile(
  disk: SkillDisk,
  folder: number,
  path: string,
): Promise<{ file: SkillFile; bytes: Buffer }> {
  const parts = path.startsWith("./") ? path.slice(2).split("/") : path.split("/");
  const name = parts.pop();
  const missing = () => new SkillError("not_found", `This skill has no file ${path}.`);
  if (!name || hidden(name) || parts.some(hidden) || (parts.length === 0 && name === "SKILL.md"))
    throw missing();
  const opened: number[] = [];
  try {
    let directory = folder;
    for (const part of parts) {
      const child = await disk.openDirectory(directory, part);
      if (child === undefined) throw missing();
      opened.push(child);
      directory = child;
    }
    const entry = await disk.readEntry(directory, name, skillFileLimits.bytes);
    if (entry === undefined) throw missing();
    if (entry === "too_large")
      throw new SkillError("limit", `${path} is over ${skillFileLimits.bytes / 1024 / 1024} MB.`);
    return {
      file: {
        path: parts.length ? `${parts.join("/")}/${name}` : name,
        size: entry.bytes.length,
        hash: sha256(entry.bytes),
        executable: entry.executable,
      },
      bytes: entry.bytes,
    };
  } finally {
    for (const fd of opened.toReversed()) await disk.closeDirectory(fd);
  }
}
