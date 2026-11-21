import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportProblems } from "@ace/marketplace";
import { CliFailure } from "./output.ts";
import type { SpadeCall } from "./spade-bots.ts";
import { exportSkill, importSkill } from "./spade-skills.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spade-skills-"));
  dirs.push(dir);
  return dir;
}

const original = [
  "---",
  "name: triage-mail",
  "description: Sorts a mail inbox into what needs a reply today.",
  "license: MIT",
  "allowed-tools: Bash Read",
  "disable-model-invocation: true",
  "model: fast",
  "---",
  "# Triage mail",
  "",
  "Run scripts/run.sh first.",
  "",
].join("\n");

async function skillFolder(markdown = original): Promise<string> {
  const root = join(await scratch(), "triage-mail");
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "SKILL.md"), markdown);
  await writeFile(join(root, "scripts/run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  await writeFile(join(root, ".DS_Store"), "x");
  return root;
}

interface Sent {
  name: string;
  description: string;
  manual: boolean;
  skill_md: string;
  files: { path: string; executable: boolean; content: string }[];
  source: string;
}

/** A Spade that keeps each import as it came, as its store does, and gives it back to export. */
function fakeSpade(): { call: SpadeCall; imports: Sent[] } {
  const imports: Sent[] = [];
  const call: SpadeCall = async (method, path, body) => {
    if (method === "POST" && path === "/v1/skills/import") {
      imports.push(body as Sent);
      return JSON.stringify({ id: `sks_${imports.length}` });
    }
    const last = imports.at(-1);
    if (method === "GET" && path === "/v1/skills")
      return JSON.stringify({
        skills: last ? [{ id: `sks_${imports.length}`, name: last.name, origin: "spade" }] : [],
      });
    if (method === "GET" && last && path === `/v1/skills/sks_${imports.length}/export`)
      return JSON.stringify({
        name: last.name,
        origin: "spade",
        source: last.source,
        files: [
          {
            path: "SKILL.md",
            executable: false,
            content: Buffer.from(last.skill_md).toString("base64"),
          },
          ...last.files,
        ],
      });
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { call, imports };
}

describe("ace spade skill import and export", () => {
  it("imports a folder's files as they are, leaving hidden ones out, and says what allowed-tools means", async () => {
    const root = await skillFolder();
    const spade = fakeSpade();
    const imported = await importSkill(spade.call, { from: root, git: false, replace: false });
    expect(imported).toMatchObject({ name: "triage-mail", source: root, skipped: [".DS_Store"] });
    expect(imported.warnings.map((warning) => warning.message)).toEqual([
      "Not used by this Spade: model.",
      "It asks to run Bash and Read without asking. Spade still decides each call.",
    ]);
    const sent = spade.imports[0];
    expect(sent?.skill_md).toBe(original);
    expect(sent?.manual).toBe(true);
    expect(sent?.files.map((file) => [file.path, file.executable])).toEqual([
      ["scripts/run.sh", true],
    ]);
  });

  it("refuses a folder that breaks the specification before Spade sees it", async () => {
    const root = await skillFolder(original.replace("name: triage-mail", "name: Triage"));
    const spade = fakeSpade();
    const failure = await importSkill(spade.call, { from: root, git: false, replace: false }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CliFailure);
    expect(spade.imports).toEqual([]);
  });

  it("exports a folder the specification's validator passes, which imports back as the same skill", async () => {
    const spade = fakeSpade();
    const first = await skillFolder();
    await importSkill(spade.call, { from: first, git: false, replace: false });
    const into = await scratch();
    const exported = await exportSkill(spade.call, "triage-mail", into);
    expect(exported.source).toBe(first);
    const markdown = await readFile(join(exported.path, "SKILL.md"), "utf8");
    expect(exportProblems("triage-mail", markdown)).toEqual([]);
    expect(markdown).toContain("spade.source:");
    const script = await stat(join(exported.path, "scripts/run.sh"));
    expect(script.mode & 0o111).not.toBe(0);

    await importSkill(spade.call, { from: exported.path, git: false, replace: true });
    const [before, after] = spade.imports;
    expect(after?.skill_md).toBe(before?.skill_md);
    expect(after?.files).toEqual(before?.files);
    expect(after?.manual).toBe(true);
  });

  it("never writes over a folder that is already there", async () => {
    const spade = fakeSpade();
    await importSkill(spade.call, { from: await skillFolder(), git: false, replace: false });
    const into = await scratch();
    await mkdir(join(into, "triage-mail"));
    await expect(exportSkill(spade.call, "triage-mail", into)).rejects.toThrow("already exists");
  });
});
