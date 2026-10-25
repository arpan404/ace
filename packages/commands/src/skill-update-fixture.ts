/** Test support for the skill update process tests: a home with `demo` installed by `skills`. */
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SkillEntry, SkillResult, SkillUpdateReview } from "@ace/protocol";
import { SkillLibrary } from "./index.ts";
import type { OpenCommandChild } from "./posix.ts";

export const installedHash = "a".repeat(40);
export const upstreamHash = "b".repeat(40);
export const v1 = "---\nname: demo\ndescription: Demo\n---\nFirst version.\n";
export const v2 = "---\nname: demo\ndescription: Demo\n---\nSecond version.\n";
export const installed = { "demo/SKILL.md": v1, "demo/notes.md": "Notes v1.\n" };
export const updated = { "demo/SKILL.md": v2, "demo/notes.md": "Notes v2.\n" };
export async function put(path: string, text: string | Buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
export const lock = (folderHash: string) =>
  JSON.stringify({
    version: 3,
    skills: {
      demo: {
        source: "acme/skills",
        sourceType: "github",
        sourceUrl: "https://github.com/acme/skills.git",
        skillPath: "skills/demo/SKILL.md",
        skillFolderHash: folderHash,
      },
    },
  });

/**
 * `demo` installed at `installedHash`; its source (`upstream`) now has `upstreamHash`. Each
 * `library()` is one ace: give two different `data` names to stand for two daemons.
 */
export async function updateHome() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-skill-updates-")));
  const home = join(root, "home");
  const skills = join(home, ".agents/skills");
  const upstream = join(root, "upstream");
  const lockPath = join(home, ".agents/.skill-lock.json");
  await put(join(skills, "demo/SKILL.md"), v1);
  await put(join(skills, "demo/notes.md"), "Notes v1.\n");
  await put(join(upstream, "SKILL.md"), v2);
  await put(join(upstream, "notes.md"), "Notes v2.\n");
  await put(lockPath, lock(installedHash));
  const libraries: SkillLibrary[] = [];
  let sequence = 0;
  const library = (
    options: {
      data?: string;
      openChild?: OpenCommandChild;
      report?: (message: string, path: string) => void;
    } = {},
  ) => {
    const data = join(root, options.data ?? "data");
    const made = new SkillLibrary({
      homes: {
        home,
        claude: join(home, ".claude"),
        codex: join(home, ".codex"),
        opencode: join(home, ".config/opencode"),
        cursor: join(home, ".cursor"),
        pi: join(home, ".pi/agent"),
      },
      workspace: () => undefined,
      openChild: options.openChild,
      updates: {
        fetcher: {
          fetch: async (_url, _ref, temporary) => ({ gitRoot: temporary, commit: "c".repeat(40) }),
          treeHash: async () => upstreamHash,
          extract: async (_gitRoot, _commit, _folder, destination) =>
            cp(upstream, destination, { recursive: true }),
        },
        temporaryRoot: join(data, "skill-updates"),
        journalRoot: join(data, "skill-update-journals"),
        lockPath,
        report: options.report,
        now: () => Date.parse("2026-10-25T00:00:00.000Z"),
        id: () => `t${++sequence}`,
      },
      id: () => `w${++sequence}`,
    });
    libraries.push(made);
    return made;
  };
  /** Everything in the skill root, hidden entries included, with file contents. */
  const folder = async () => {
    const out: Record<string, string> = {};
    const visit = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = `${prefix}${entry.name}`;
        if (entry.isDirectory()) await visit(join(directory, entry.name), `${path}/`);
        else out[path] = await readFile(join(directory, entry.name), "utf8");
      }
    };
    await visit(skills, "");
    return out;
  };
  const close = async () => {
    await chmod(join(home, ".agents"), 0o755).catch(() => {});
    await chmod(skills, 0o755).catch(() => {});
    for (const made of libraries) await made.close();
    await rm(root, { recursive: true, force: true });
  };
  return { root, home, skills, upstream, lockPath, library, folder, close };
}
export async function demo(library: SkillLibrary): Promise<SkillEntry> {
  const result = await library.request({ op: "list" });
  const entry = result.kind === "list" ? result.entries.find((e) => e.name === "demo") : undefined;
  if (!entry) throw new Error(JSON.stringify(result));
  return entry;
}
export async function prepare(
  library: SkillLibrary,
  entry: SkillEntry,
): Promise<SkillUpdateReview> {
  const result = await library.request({ op: "prepareUpdate", id: entry.id });
  if (result.kind !== "updateReview") throw new Error(JSON.stringify(result));
  return result.review;
}
export const apply = (library: SkillLibrary, entry: SkillEntry, review: SkillUpdateReview) =>
  library.request({
    op: "applyUpdate",
    id: entry.id,
    reviewId: review.id,
    expectedHash: review.baseHash,
  });
export const errorCode = (result: SkillResult) =>
  result.kind === "error" ? result.code : result.kind;
