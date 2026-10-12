import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { prepareBuiltinSkills } from "@ace/plugins";
import { builtinSkillRecovery, createBuiltinSkillRoot } from "./builtin-skill-roots.ts";

const skillPath = (root: string) =>
  join(root, "generated/plugins/ace-builtins/skills/visualize/SKILL.md");

test("restart reclaims a crashed session after provider recovery and preserves fresh sessions and unowned files", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-skill-restart-"));
  try {
    const abandoned = await createBuiltinSkillRoot(dataDir);
    await prepareBuiltinSkills("claude", abandoned); // Simulate SIGKILL: never call close.
    const unowned = await createBuiltinSkillRoot(dataDir);
    await writeFile(join(unowned, "person.md"), "Keep this file");
    const collect = await builtinSkillRecovery(dataDir);
    const active = await createBuiltinSkillRoot(dataDir);
    const live = await prepareBuiltinSkills("codex", active);
    const recovered = Promise.withResolvers<void>();
    const collecting = collect(recovered.promise, () => {});
    expect(await readFile(skillPath(abandoned), "utf8")).toContain("ace_html_render");
    recovered.resolve();
    await collecting;
    await expect(readFile(skillPath(abandoned))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(skillPath(active), "utf8")).toContain("ace_html_render");
    expect(await readFile(join(unowned, "person.md"), "utf8")).toBe("Keep this file");
    await live.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("failed provider recovery leaves the previous projection available", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-skill-recovery-"));
  try {
    const abandoned = await createBuiltinSkillRoot(dataDir);
    await prepareBuiltinSkills("codex", abandoned);
    const collect = await builtinSkillRecovery(dataDir);
    await expect(collect(Promise.reject(new Error("Recovery failed")), () => {})).rejects.toThrow(
      "Recovery failed",
    );
    expect(await readFile(skillPath(abandoned), "utf8")).toContain("ace_html_render");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
