import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { setup } from "./testing/v2-session.ts";

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});
async function skillsDirectory(...names: string[]) {
  const root = await mkdtemp(join(tmpdir(), "ace-opencode-skills-"));
  cleanup.push(root);
  for (const name of names) {
    await mkdir(join(root, name));
    await writeFile(
      join(root, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Use for ${name}.\n---\n\nBody.\n`,
    );
  }
  return root;
}
const Skills = z.object({ data: z.array(z.object({ name: z.string() })) });

it("OpenCode discovers ace's shipped skills at session start, beside the person's own", async () => {
  const ace = await skillsDirectory("ace-browser", "ace-agents");
  const own = await skillsDirectory("my-deploy");
  const h = await setup(
    // The person's runtime config already names a skills folder of their own.
    { discovery: { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: [own] }) } } },
    undefined,
    { builtinSkills: { args: [], directories: [ace] } },
  );
  const listed = Skills.parse(await h.control("/api/skill")).data.map((skill) => skill.name);
  expect(listed).toEqual(expect.arrayContaining(["ace-browser", "ace-agents", "my-deploy"]));
  // Project skills OpenCode found on its own stay listed too.
  expect(listed).toContain("review");
});
