import { afterEach, expect, test, vi } from "vitest";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SkillEntry, SkillResult } from "@ace/protocol";
import { SkillLibrary } from "./index.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
const skillText = (name: string, extra = "") =>
  `---\nname: ${name}\n# kept comment\ndescription: The ${name} skill\n${extra}---\n# ${name} title\n\nDo the ${name} work.\n`;

/** A home laid out like the owner's: one shared folder linked into Claude, plus copies. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-skill-library-")));
  const home = join(root, "home");
  const project = join(root, "project");
  const shipped = join(root, "shipped");
  await put(join(home, ".agents/skills/research/SKILL.md"), skillText("research"));
  await mkdir(join(home, ".claude/skills"), { recursive: true });
  await symlink("../../.agents/skills/research", join(home, ".claude/skills/research"));
  await put(join(home, ".claude/skills/cloudflare/SKILL.md"), skillText("cloudflare"));
  await put(join(home, ".codex/skills/cloudflare/SKILL.md"), skillText("cloudflare", "x: 1\n"));
  await put(join(root, "outside/elsewhere/SKILL.md"), skillText("elsewhere"));
  await symlink(join(root, "outside/elsewhere"), join(home, ".claude/skills/elsewhere"));
  await put(join(project, ".claude/skills/release/SKILL.md"), skillText("release"));
  await put(join(shipped, "visualize/SKILL.md"), skillText("visualize"));
  let sequence = 0;
  const library = new SkillLibrary({
    homes: {
      home,
      claude: join(home, ".claude"),
      codex: join(home, ".codex"),
      opencode: join(home, ".config/opencode"),
      cursor: join(home, ".cursor"),
      pi: join(home, ".pi/agent"),
    },
    workspace: (id) => (id === "project" ? project : undefined),
    builtinDirectory: shipped,
    id: () => `t${++sequence}`,
  });
  cleanups.push(async () => {
    await library.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, home, project, library };
}
async function list(library: SkillLibrary, workspaceId?: string): Promise<SkillEntry[]> {
  const result = await library.request({ op: "list", workspaceId });
  if (result.kind !== "list") throw new Error(JSON.stringify(result));
  return result.entries;
}
async function named(library: SkillLibrary, name: string, workspaceId?: string) {
  const entry = (await list(library, workspaceId)).find((e) => e.name === name);
  if (!entry) throw new Error(`Missing ${name}`);
  return entry;
}
function skill(result: SkillResult) {
  if (result.kind !== "skill") throw new Error(JSON.stringify(result));
  return result;
}
const agents = (entry: SkillEntry) => entry.agents.map((a) => `${a.provider}:${a.via}`);

test("a linked skill is listed once, with each agent's access and a copy kept separate", async () => {
  const { library } = await fixture();
  const entries = await list(library, "project");
  expect(entries.filter((e) => e.name === "research")).toHaveLength(1);
  const research = await named(library, "research");
  expect(research).toMatchObject({
    scope: "personal",
    path: "~/.agents/skills/research",
    title: "research title",
    editable: true,
  });
  expect(agents(research)).toEqual([
    "claude:link",
    "codex:native",
    "opencode:native",
    "cursor:native",
    "pi:native",
  ]);
  expect(research.agents.find((a) => a.provider === "claude")?.removable).toBe(true);
  const cloudflare = entries.filter((e) => e.name === "cloudflare");
  expect(cloudflare).toHaveLength(1);
  expect(agents(cloudflare[0] as SkillEntry)).toEqual([
    "claude:native",
    "codex:copy",
    "opencode:native",
    "cursor:native",
  ]);
  expect(entries.find((e) => e.name === "release")).toMatchObject({
    scope: "project",
    path: ".claude/skills/release",
  });
  expect(entries.find((e) => e.name === "visualize")).toMatchObject({
    scope: "builtin",
    editable: false,
  });
  expect(entries.find((e) => e.name === "elsewhere")?.editable).toBe(false);
  expect((await list(library)).some((e) => e.scope === "project")).toBe(false);
});

test("creating a skill saves it in the shared folder and links it for Claude", async () => {
  const { home, library } = await fixture();
  const created = skill(
    await library.request({
      op: "create",
      name: "release-notes",
      description: "Write release notes",
      body: "# Release notes\n\nList what changed.\n",
      scope: { kind: "personal" },
      agents: ["claude", "codex"],
      manual: true,
    }),
  );
  const text = await readFile(join(home, ".agents/skills/release-notes/SKILL.md"), "utf8");
  expect(text).toContain("disable-model-invocation: true");
  expect(created.text).toBe(text);
  expect(await readlink(join(home, ".claude/skills/release-notes"))).toBe(
    "../../.agents/skills/release-notes",
  );
  expect(created.entry).toMatchObject({ manual: true, description: "Write release notes" });
  expect(agents(created.entry)).toContain("claude:link");
  const again = await library.request({
    op: "create",
    name: "research",
    description: "Duplicate",
    body: "",
    scope: { kind: "personal" },
    agents: ["claude"],
  });
  expect(again).toMatchObject({ kind: "error", code: "exists" });
  expect(await readFile(join(home, ".agents/skills/research/SKILL.md"), "utf8")).toBe(
    skillText("research"),
  );
});

test("edits keep unknown frontmatter and comments, and a stale hash is refused", async () => {
  const { home, library } = await fixture();
  const research = await named(library, "research");
  const edit = {
    op: "edit",
    id: research.id,
    expectedHash: research.hash,
    description: "Look things up",
    body: "# Research\n\nNew steps.\n",
    manual: true,
  };
  const saved = skill(await library.request(edit));
  const text = await readFile(join(home, ".agents/skills/research/SKILL.md"), "utf8");
  expect(text).toContain("# kept comment");
  expect(text).toContain("name: research");
  expect(text).toContain("disable-model-invocation: true");
  expect(text.endsWith("# Research\n\nNew steps.\n")).toBe(true);
  expect(saved.entry).toMatchObject({ description: "Look things up", manual: true });
  expect(await library.request(edit)).toMatchObject({ kind: "error", code: "conflict" });
  const off = skill(
    await library.request({ ...edit, expectedHash: saved.entry.hash, manual: false }),
  );
  expect(off.text).not.toContain("disable-model-invocation");
});

test("changing agents removes links but never real folders or the canonical agent", async () => {
  const { home, library } = await fixture();
  const research = await named(library, "research");
  const unlinked = skill(
    await library.request({ op: "setAgents", id: research.id, agents: ["codex", "opencode"] }),
  );
  expect(await lstat(join(home, ".claude/skills/research")).catch(() => undefined)).toBeUndefined();
  expect(agents(unlinked.entry)).not.toContain("claude:link");
  expect(unlinked.kept).toEqual(
    expect.arrayContaining([
      { provider: "cursor", reason: "canonical" },
      { provider: "pi", reason: "canonical" },
    ]),
  );
  const cloudflare = await named(library, "cloudflare");
  const kept = skill(await library.request({ op: "setAgents", id: cloudflare.id, agents: [] }));
  expect(kept.kept).toEqual(
    expect.arrayContaining([
      { provider: "claude", reason: "canonical" },
      { provider: "codex", reason: "copy" },
    ]),
  );
  expect(await readFile(join(home, ".codex/skills/cloudflare/SKILL.md"), "utf8")).toContain("x: 1");
  const relinked = skill(
    await library.request({ op: "setAgents", id: research.id, agents: ["claude", "codex"] }),
  );
  expect(agents(relinked.entry)).toContain("claude:link");
});

test("deleting removes the folder and its links, and read-only skills refuse changes", async () => {
  const { root, home, library } = await fixture();
  const research = await named(library, "research");
  expect(
    await library.request({ op: "delete", id: research.id, expectedHash: "0".repeat(64) }),
  ).toMatchObject({ kind: "error", code: "conflict" });
  expect(
    await library.request({ op: "delete", id: research.id, expectedHash: research.hash }),
  ).toEqual({
    kind: "deleted",
    id: research.id,
  });
  expect(await lstat(join(home, ".agents/skills/research")).catch(() => undefined)).toBeUndefined();
  expect(await lstat(join(home, ".claude/skills/research")).catch(() => undefined)).toBeUndefined();
  for (const name of ["visualize", "elsewhere"]) {
    const entry = await named(library, name);
    const refused = await library.request({
      op: "edit",
      id: entry.id,
      expectedHash: entry.hash,
      description: "Changed",
      body: "Changed",
      manual: false,
    });
    expect(refused).toMatchObject({ kind: "error", code: "read_only" });
  }
  expect(await readFile(join(root, "outside/elsewhere/SKILL.md"), "utf8")).toBe(
    skillText("elsewhere"),
  );
  expect(await library.request({ op: "read", id: `skl_${"0".repeat(40)}` })).toMatchObject({
    kind: "error",
    code: "not_found",
  });
});

test("subscribers hear about skills added outside ace", async () => {
  const { home, library } = await fixture();
  const changed = vi.fn();
  const stop = library.subscribe(undefined, changed);
  try {
    await vi.waitFor(async () => {
      await put(join(home, ".agents/skills/fresh/SKILL.md"), skillText("fresh"));
      expect(changed).toHaveBeenCalled();
    }, 10_000);
    expect((await list(library)).some((e) => e.name === "fresh")).toBe(true);
  } finally {
    stop();
  }
});
