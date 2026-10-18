import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommandLibrary } from "./index.ts";
import type { CatalogEntry, ProviderKind } from "@ace/protocol";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function put(path: string, body: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}
async function fixture(provider: ProviderKind) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-skill-catalog-")));
  const home = join(root, "provider"),
    project = join(root, "project"),
    shipped = join(root, "shipped");
  await Promise.all([mkdir(home), mkdir(project), mkdir(shipped)]);
  await put(
    join(shipped, "visualize/SKILL.md"),
    "---\nname: visualize\ndescription: Draw a diagram\n---\nRender with diagram.md.\n",
  );
  const library = new CommandLibrary({
    aceHome: join(root, "ace"),
    instances: [{ id: provider, provider, home }],
    context: () => ({ workspace: project, provider, instance: provider }),
    now: () => 1000,
    builtinSkills: { directory: shipped, providers: ["cursor", "acp", "antigravity"] },
  });
  cleanups.push(async () => {
    await library.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, home, shipped, library };
}
async function skills(library: CommandLibrary, query: string): Promise<CatalogEntry[]> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await library.listCatalog("thread", query, 100);
    const found = result.entries.filter((entry) => entry.kind === "skill");
    if (!result.stale && found.length) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return [];
}

test("an ACP agent receives ace's shipped skill body read from disk when the person selects it", async () => {
  const f = await fixture("acp");
  const [visualize] = await skills(f.library, "visualize");
  if (!visualize) throw new Error("Shipped skill missing from the ACP catalog");
  const prepared = await f.library.prepareMentions("thread", [
    { type: "mention", entryId: visualize.id, name: "visualize", kind: "skill", arguments: "" },
    { type: "text", text: " the queue states" },
  ]);
  expect(prepared).toHaveLength(1);
  const text = prepared[0]?.type === "text" ? prepared[0].text : "";
  expect(text).toContain(`path=${JSON.stringify(join(f.shipped, "visualize/SKILL.md"))}`);
  expect(text).toContain("Render with diagram.md.\n</skill>");
  expect(text).not.toContain("description: Draw a diagram");
  expect(text.endsWith("[skill: visualize] the queue states")).toBe(true);
});

test("providers that load the shipped skills natively do not list a second copy", async () => {
  const f = await fixture("codex");
  let result = await f.library.listCatalog("thread", "", 512);
  for (let attempt = 0; attempt < 200 && result.stale; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    result = await f.library.listCatalog("thread", "", 512);
  }
  expect(result.stale).toBe(false);
  expect(result.entries.some((e) => e.kind === "skill" && e.source.provider === "ace")).toBe(false);
});

test("a Cursor skill edited after selection is sent with its current body", async () => {
  const f = await fixture("cursor");
  await put(
    join(f.home, "skills/release/SKILL.md"),
    "---\nname: release\ndescription: Cut a release\n---\nTag $ARGUMENTS.\n",
  );
  const release = (await skills(f.library, "release")).find((e) => e.name === "release");
  if (!release) throw new Error("Cursor skill missing");
  const send = () =>
    f.library.prepareMentions("thread", [
      { type: "mention", entryId: release.id, name: "release", kind: "skill", arguments: "v2" },
    ]);
  expect(JSON.stringify(await send())).toContain("Tag v2.");
  await put(
    join(f.home, "skills/release/SKILL.md"),
    "---\nname: release\ndescription: Cut a release\n---\nTag and publish $ARGUMENTS.\n",
  );
  let latest = "";
  for (let attempt = 0; attempt < 200 && !latest.includes("publish"); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    latest = JSON.stringify(await send());
  }
  expect(latest).toContain("Tag and publish v2.");
});

test("a skill that is deleted or no longer user-invocable is refused before provider input exists", async () => {
  const f = await fixture("cursor");
  const file = join(f.home, "skills/gone/SKILL.md");
  await put(file, "---\nname: gone\ndescription: Soon removed\n---\nBody\n");
  const gone = (await skills(f.library, "gone")).find((e) => e.name === "gone");
  if (!gone) throw new Error("Cursor skill missing");
  await put(file, "---\nname: gone\ndescription: Soon removed\nuser-invocable: false\n---\nBody\n");
  const send = () =>
    f.library.prepareMentions("thread", [
      { type: "mention", entryId: gone.id, name: "gone", kind: "skill", arguments: "" },
    ]);
  let error: unknown;
  for (let attempt = 0; attempt < 200 && !error; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    error = await send().then(
      () => undefined,
      (failure: unknown) => failure,
    );
  }
  expect(String(error)).toContain("catalog_mention_unavailable");
});
