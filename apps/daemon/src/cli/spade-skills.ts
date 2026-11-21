import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  exportProblems,
  exportSkillMd,
  importSkillMd,
  readSkillMd,
  type ArchiveFile,
} from "@ace/marketplace";
import type { CliProblem } from "@ace/protocol/cli-output";
import type { CliSpadeSkillExport, CliSpadeSkillImport } from "@ace/protocol/cli-outputs";
import { readFolder } from "./market/folder.ts";
import { CliFailure } from "./output.ts";
import { skillWarnings } from "./bot-kit/check.ts";
import type { SpadeCall } from "./spade-bots.ts";

/*
 * `ace spade skill import` and `export` (ADR 0202 §1): a folder made to the Agent Skills
 * specification becomes a skill written in Spade, and a Spade skill becomes a folder other
 * runtimes read. The folder is checked here with the market's skill check (the specification's
 * rules, secrets, limits); Spade holds the name and description rules and the paths again.
 * Hidden files and `.git` are not part of a skill and are left out.
 */

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const hidden = (path: string) => path.split("/").some((part) => part.startsWith("."));

/** What Spade's import takes, from a skill folder's files. Pure. */
export function importBody(
  name: string,
  files: readonly ArchiveFile[],
  source: string,
  replace: boolean,
): {
  body: unknown;
  skipped: string[];
  warnings: CliProblem[];
} {
  const skipped = files.filter((file) => hidden(file.path)).map((file) => file.path);
  const kept = files.filter((file) => !hidden(file.path));
  const top = kept.find((file) => file.path === "SKILL.md");
  const markdown = top ? new TextDecoder().decode(top.content) : "";
  const stored = importSkillMd(markdown).markdown;
  const read = readSkillMd(stored);
  return {
    body: {
      name,
      description: read.description,
      manual: read.manual,
      skill_md: stored,
      files: kept
        .filter((file) => file.path !== "SKILL.md")
        .map((file) => ({
          path: file.path,
          executable: file.executable,
          content: encode(file.content),
        })),
      source,
      replace,
    },
    skipped,
    warnings: skillWarnings(stored),
  };
}

/** A git address the plugin fetcher takes: https, ssh or `user@host:path`. */
export const isGitAddress = (text: string) =>
  /^(?:https:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(text);

/** The skill folder at `address` (`folder` inside it, `.` for the root) as files. */
async function gitFolder(address: string, folder: string): Promise<ArchiveFile[]> {
  const { extractPlugin, fetchRepository, gitRuntime } = await import("@ace/plugins");
  const runtime = gitRuntime();
  // The extractor refuses a path through a link, and macOS's temporary folder is under one.
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "ace-skill-import-")));
  try {
    const { gitRoot, commit } = await fetchRepository(address, "HEAD", temporary, runtime);
    const destination = join(temporary, "skill");
    await extractPlugin(gitRoot, commit, folder, destination, runtime);
    await runtime.release(temporary);
    return await readFolder(destination);
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw new CliFailure(
      "failed",
      `Couldn't read ${address}: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      { code: "failed" },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const lastPart = (path: string) => path.split(/[\\/]/).findLast(Boolean) ?? "";

/** Where an import reads from: a folder, or a git address with the folder inside it. */
export interface ImportFrom {
  readonly from: string;
  /** Read `from` as a git address, a local repository's path included. */
  readonly git: boolean;
  /** With `git`, the skill's folder in the repository; its root by default. */
  readonly path?: string | undefined;
  readonly replace: boolean;
}

/** Imports the skill folder `from` describes into Spade. */
export async function importSkill(call: SpadeCall, from: ImportFrom): Promise<CliSpadeSkillImport> {
  const git = from.git || isGitAddress(from.from);
  const inside = from.path?.replace(/^\.\/|\/$/g, "") || ".";
  const name = git
    ? lastPart(inside === "." ? from.from.replace(/\.git$/, "") : inside)
    : lastPart(resolve(from.from));
  const files = git ? await gitFolder(from.from, inside) : await readFolder(resolve(from.from));
  const source = git ? `${from.from}${inside === "." ? "" : `#${inside}`}` : resolve(from.from);
  const shown = files.filter((file) => !hidden(file.path));
  const { checkFiles } = await import("@ace/marketplace/checks");
  const checked = checkFiles("spade-skill", name, shown);
  if (checked.problems.length > 0) {
    const count = checked.problems.length;
    throw new CliFailure(
      "failed",
      `${name} has ${count} problem${count === 1 ? "" : "s"} to fix before Spade takes it.`,
      { problems: checked.problems },
      { code: "check_failed", problems: [...checked.problems] },
    );
  }
  const made = importBody(name, files, source, from.replace);
  const answer = JSON.parse(await call("POST", "/v1/skills/import", made.body)) as {
    id?: unknown;
  };
  return {
    id: typeof answer.id === "string" ? answer.id : "",
    name,
    source,
    files: shown.length,
    skipped: made.skipped,
    warnings: made.warnings,
  };
}

/** A Spade skill's export as Spade gives it. */
interface Exported {
  name: string;
  origin: string;
  source: string | null | undefined;
  files: { path: string; executable: boolean; content: string }[];
}

/** Where a skill came from, as `metadata.spade.source` says it. Pure. */
export function sourceOf(skill: Pick<Exported, "origin" | "source">): string {
  if (skill.origin === "spade") return skill.source || "spade";
  return skill.source ? `${skill.origin}:${skill.source}` : skill.origin;
}

/**
 * The files of a skill's export: `SKILL.md` written to pass the specification's validator, the
 * rest as Spade keeps them. Pure.
 */
export function exportFiles(skill: Exported): ArchiveFile[] {
  return skill.files.map((file) => {
    const content = new Uint8Array(Buffer.from(file.content, "base64"));
    if (file.path !== "SKILL.md") return { path: file.path, executable: file.executable, content };
    const markdown = exportSkillMd(new TextDecoder().decode(content), {
      source: sourceOf(skill),
    });
    const problems = exportProblems(skill.name, markdown);
    if (problems.length > 0)
      throw new CliFailure(
        "failed",
        `${skill.name} doesn't meet the specification as Spade keeps it: ${problems[0]?.message}`,
        { problems },
        { code: "check_failed", problems },
      );
    return { path: file.path, executable: false, content: new TextEncoder().encode(markdown) };
  });
}

interface Listed {
  id: string;
  name: string;
  origin: string;
}

/** The store skill `wanted` names, by id or name. Pure. */
export function findSkill(skills: readonly Listed[], wanted: string): Listed {
  const found =
    skills.find((skill) => skill.id === wanted) ??
    skills.find((skill) => skill.name === wanted && skill.origin === "spade") ??
    skills.find((skill) => skill.name === wanted);
  if (!found)
    throw new CliFailure("refused", `Spade has no skill called ${wanted}.`, undefined, {
      code: "not_found",
      hint: "See Spade's skills in Settings › Skills.",
    });
  return found;
}

/** Writes the Spade skill `wanted` as a folder `<into>/<name>/`, which must not exist yet. */
export async function exportSkill(
  call: SpadeCall,
  wanted: string,
  into: string,
): Promise<CliSpadeSkillExport> {
  const listed = JSON.parse(await call("GET", "/v1/skills")) as { skills?: Listed[] };
  const skill = findSkill(listed.skills ?? [], wanted);
  const exported = JSON.parse(
    await call("GET", `/v1/skills/${encodeURIComponent(skill.id)}/export`),
  ) as Exported;
  const files = exportFiles(exported);
  const folder = resolve(into, exported.name);
  if (
    await stat(folder).then(
      () => true,
      () => false,
    )
  )
    throw new CliFailure("refused", `${folder} already exists.`, undefined, {
      code: "conflict",
      hint: "Export somewhere else, or move that folder first.",
    });
  for (const file of files) {
    const path = join(folder, ...file.path.split("/"));
    if (!path.startsWith(folder)) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, { mode: file.executable ? 0o755 : 0o644, flag: "wx" });
  }
  return { name: exported.name, path: folder, files: files.length, source: sourceOf(exported) };
}
