import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { mirrorCursorUserConfig } from "./user-settings.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function homes() {
  const root = await mkdtemp(join(tmpdir(), "cursor-user-config-"));
  roots.push(root);
  const user = join(root, "real");
  const instance = join(root, "instance", "user");
  await mkdir(join(user, ".cursor", "rules"), { recursive: true });
  await mkdir(join(user, ".cursor", "skills", "deploy"), { recursive: true });
  await mkdir(join(user, ".cursor", "sdk"), { recursive: true });
  await writeFile(join(user, ".cursor", "mcp.json"), '{"mcpServers":{"mine":{"url":"x"}}}');
  await writeFile(join(user, ".cursor", "rules", "style.mdc"), "Use tabs.");
  await writeFile(join(user, ".cursor", "skills", "deploy", "SKILL.md"), "# Deploy");
  await writeFile(join(user, ".cursor", "sdk", "auth.json"), '{"token":"real-secret"}');
  await writeFile(join(user, ".cursor", "cli-config.json"), '{"authInfo":"secret"}');
  await mkdir(join(instance, ".cursor", "sdk"), { recursive: true });
  await writeFile(join(instance, ".cursor", "sdk", "auth.json"), '{"token":"private"}');
  return { root, user, instance };
}

test("the private Cursor home gets the person's MCP servers, rules and skills but none of their credentials", async () => {
  const { user, instance } = await homes();
  const result = await mirrorCursorUserConfig(user, instance);
  expect(result.copied.toSorted()).toEqual(["mcp.json", "rules", "skills"]);
  const cursor = join(instance, ".cursor");
  expect(await readFile(join(cursor, "mcp.json"), "utf8")).toContain('"mine"');
  expect(await readFile(join(cursor, "rules", "style.mdc"), "utf8")).toBe("Use tabs.");
  expect(await readFile(join(cursor, "skills", "deploy", "SKILL.md"), "utf8")).toBe("# Deploy");
  // ace's own credential store stays; the person's never comes across.
  expect(await readFile(join(cursor, "sdk", "auth.json"), "utf8")).toBe('{"token":"private"}');
  expect((await readdir(cursor)).toSorted()).toEqual(["mcp.json", "rules", "sdk", "skills"]);
});

test("whatever the SDK writes in the private home never reaches the person's ~/.cursor", async () => {
  const { user, instance } = await homes();
  await mirrorCursorUserConfig(user, instance);
  await writeFile(join(instance, ".cursor", "mcp.json"), "{}");
  await writeFile(join(instance, ".cursor", "rules", "style.mdc"), "changed");
  expect(await readFile(join(user, ".cursor", "mcp.json"), "utf8")).toContain('"mine"');
  expect(await readFile(join(user, ".cursor", "rules", "style.mdc"), "utf8")).toBe("Use tabs.");
});

test("each session start reflects the person's current config, including removals", async () => {
  const { user, instance } = await homes();
  await mirrorCursorUserConfig(user, instance);
  await rm(join(user, ".cursor", "rules"), { recursive: true });
  await writeFile(join(user, ".cursor", "mcp.json"), '{"mcpServers":{"renamed":{"url":"y"}}}');
  await mirrorCursorUserConfig(user, instance);
  const cursor = join(instance, ".cursor");
  expect(await readFile(join(cursor, "mcp.json"), "utf8")).toContain('"renamed"');
  expect((await readdir(cursor)).toSorted()).toEqual(["mcp.json", "sdk", "skills"]);
});

test("links inside the person's config are not followed and oversized entries are left out", async () => {
  const { root, user, instance } = await homes();
  await writeFile(join(root, "outside.txt"), "outside");
  await symlink(join(root, "outside.txt"), join(user, ".cursor", "rules", "escape.mdc"));
  await mkdir(join(user, ".cursor", "plugins"));
  await writeFile(join(user, ".cursor", "plugins", "huge.bin"), "x".repeat(2048));
  const result = await mirrorCursorUserConfig(user, instance, { maxEntries: 64, maxBytes: 1024 });
  expect(result.skipped).toEqual([{ entry: "plugins", reason: "over size limit" }]);
  expect(await readdir(join(instance, ".cursor", "rules"))).toEqual(["style.mdc"]);
  expect((await readdir(join(instance, ".cursor"))).includes("plugins")).toBe(false);
});
