import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { createCursorAdapter } from "./index.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function skill(root: string, name: string, body: string) {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${body}\n---\n`);
}
// A supported SDK installation, resolved without touching the real one.
const discovery = {
  resolve: (id: string) =>
    id === "@cursor/sdk" ? "/sdk/dist/esm/index.js" : "/helper/package.json",
  read: async (path: string) =>
    path === "/sdk/package.json"
      ? '{"name":"@cursor/sdk","version":"1.0.35"}'
      : path === "/helper/package.json"
        ? '{"name":"@cursor/sdk-darwin-arm64","version":"1.0.35"}'
        : Promise.reject(new Error("missing")),
  executable: async () => {},
  platform: "darwin" as const,
  arch: "arm64",
  nodeVersion: "24.0.0",
};

it("a Cursor session starts with ace's shipped skills beside the person's own, theirs winning a shared name", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-skills-")));
  roots.push(root);
  const userHome = join(root, "real");
  const instanceHome = join(root, "instance");
  const shipped = join(root, "shipped");
  await skill(join(userHome, ".cursor", "skills"), "deploy", "The person's deploy steps.");
  await skill(join(userHome, ".cursor", "skills"), "ace-browser", "The person's own version.");
  await skill(shipped, "ace-browser", "ace's browser guide.");
  await skill(shipped, "ace-agents", "ace's delegation guide.");
  await mkdir(join(instanceHome, "user"), { recursive: true });
  const adapter = createCursorAdapter({
    instance: { id: "skills", homeDir: instanceHome },
    userHome,
    discovery,
    // Stop right after the private home is prepared: no SDK host is started.
    mcp: async () => {
      throw new Error("stop after setup");
    },
  });
  try {
    await expect(
      adapter.openSession({
        threadId: ThreadId.parse("cursor-skills"),
        cwd: root,
        env: { HOME: join(instanceHome, "user") },
        builtinSkills: { args: [], directories: [shipped] },
        signal: new AbortController().signal,
        onFrame: () => {},
        onExit: () => {},
      }),
    ).rejects.toThrow("stop after setup");
    const skills = join(instanceHome, "user", ".cursor", "skills");
    expect((await readdir(skills)).toSorted()).toEqual(["ace-agents", "ace-browser", "deploy"]);
    expect(await readFile(join(skills, "ace-browser", "SKILL.md"), "utf8")).toContain(
      "The person's own version.",
    );
    // The person's real ~/.cursor never receives ace's skills.
    expect((await readdir(join(userHome, ".cursor", "skills"))).toSorted()).toEqual([
      "ace-browser",
      "deploy",
    ]);
  } finally {
    await adapter.close();
  }
});
