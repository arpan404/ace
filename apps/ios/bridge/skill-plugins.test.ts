import "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { sheetFixture, until } from "./sheet-fixture.ts";
import { NativePluginsRequest, NativeSkillPlugins } from "./skill-plugins.ts";

/* Which agents a whole plugin reaches, switched from the phone, on the fake daemon's plugins. */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

interface PluginView {
  name: string;
  source: string | null;
  on: boolean;
  summary: string;
  agents: { id: string; on: boolean }[];
}
const offered = (name: string, description: string) => ({
  name,
  version: "1.0.0",
  executions: [],
  components: [
    { name, kind: "skill" as const, path: `skills/${name}/SKILL.md`, description, text: "" },
  ],
});
async function plugins(marketplace = [offered("sentry", "Read Sentry issues")]) {
  const { daemon, client } = sheetFixture();
  daemon.seedServices({
    plugins: {
      marketplace,
      unfetchable: ["https://github.com/acme/gone.git"],
      installed: [
        {
          name: "engineering",
          version: "2.3.0",
          acceptedAt: 1,
          executions: [],
          components: [
            {
              name: "code-review",
              kind: "skill",
              path: "skills/code-review/SKILL.md",
              description: "Review a diff",
              text: "# Code review\n",
            },
          ],
          providers: ["claude", "codex"],
        },
      ],
    },
  });
  close = () => client.close();
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const service = new NativeSkillPlugins(client);
  const ask = async (request: Record<string, unknown>) =>
    (await service.answer(
      NativePluginsRequest.parse({ type: "plugins.native", ...request }),
      new AbortController().signal,
    )) as Record<string, unknown> & {
      ok: boolean;
      plugin?: PluginView;
      plugins?: PluginView[];
      message?: string;
    };
  const listed = async () => (await ask({ op: "plugins" })).plugins?.[0];
  return { ask, listed };
}
const on = (view: PluginView | undefined) =>
  view?.agents.filter((agent) => agent.on).map((agent) => agent.id);

test("a plugin's line names the agents it reaches", async () => {
  const { listed } = await plugins();
  expect(await listed()).toMatchObject({
    name: "engineering",
    on: true,
    summary: "On for Claude Code and Codex",
  });
});

test("an agent ticked for a plugin reaches all of it, and unticking every agent turns it off", async () => {
  const { ask, listed } = await plugins();
  await ask({ op: "agent", name: "engineering", provider: "pi", on: true });
  expect(on(await listed())).toEqual(["claude", "codex", "pi"]);
  await ask({ op: "agent", name: "engineering", provider: "claude", on: false });
  await ask({ op: "agent", name: "engineering", provider: "codex", on: false });
  const last = await ask({ op: "agent", name: "engineering", provider: "pi", on: false });
  expect(last.plugin).toMatchObject({ on: false, summary: "Off" });
});

test("quick taps on several agents all land, none overwriting another", async () => {
  const { ask, listed } = await plugins();
  await Promise.all([
    ask({ op: "agent", name: "engineering", provider: "cursor", on: true }),
    ask({ op: "agent", name: "engineering", provider: "pi", on: true }),
    ask({ op: "agent", name: "engineering", provider: "claude", on: false }),
  ]);
  expect(on(await listed())).toEqual(["codex", "cursor", "pi"]);
});

test("switching a plugin off keeps its agents, and on again brings them back", async () => {
  const { ask, listed } = await plugins();
  expect((await ask({ op: "switch", name: "engineering", enabled: false })).plugin).toMatchObject({
    on: false,
    summary: "Off",
  });
  expect(on(await listed())).toEqual(["claude", "codex"]);
  await ask({ op: "switch", name: "engineering", enabled: true });
  expect((await listed())?.summary).toBe("On for Claude Code and Codex");
});

test("switching on a plugin with no agents gives it every agent", async () => {
  const { ask, listed } = await plugins();
  for (const provider of ["claude", "codex"])
    await ask({ op: "agent", name: "engineering", provider, on: false });
  await ask({ op: "switch", name: "engineering", enabled: true });
  expect((await listed())?.summary).toBe("On for every agent");
});

test("a change to a plugin that isn't installed is refused in words", async () => {
  const { ask } = await plugins();
  expect(await ask({ op: "switch", name: "missing", enabled: false })).toEqual({
    ok: false,
    message: "That plugin isn't installed any more.",
  });
});

test("an installed plugin says which repository and branch it came from", async () => {
  const { listed } = await plugins();
  expect((await listed())?.source).toBe("ace-fixtures/engineering @ main");
});

test("finding plugins in a repository lists its marketplace, picking the only plugin", async () => {
  const { ask } = await plugins();
  expect(await ask({ op: "find", repository: " getsentry/sentry-mcp ", ref: "" })).toEqual({
    ok: true,
    repository: "https://github.com/getsentry/sentry-mcp.git",
    ref: "HEAD",
    from: "getsentry/sentry-mcp",
    plugins: [{ name: "sentry", version: "1.0.0", description: expect.any(String) }],
    picked: "sentry",
    manual: false,
    note: null,
  });
});

test("a marketplace offering several plugins leaves the choice to the person", async () => {
  const { ask } = await plugins([
    offered("sentry", "Read Sentry issues"),
    offered("seer", "Fix issues"),
  ]);
  const found = await ask({ op: "find", repository: "getsentry/sentry-mcp", ref: "release" });
  expect(found).toMatchObject({ ref: "release", from: "getsentry/sentry-mcp @ release" });
  expect(found).toMatchObject({ picked: null });
  expect((found.plugins as { name: string }[]).map((each) => each.name)).toEqual([
    "sentry",
    "seer",
  ]);
});

test("a marketplace that lists nothing says so", async () => {
  const { ask } = await plugins([]);
  expect(await ask({ op: "find", repository: "acme/empty", ref: "" })).toMatchObject({
    plugins: [],
    picked: null,
    manual: false,
    note: "This repository's marketplace lists no plugins.",
  });
});

test("a marketplace that can't be read lets the name be typed, suggested from the repository", async () => {
  const { ask } = await plugins();
  expect(await ask({ op: "find", repository: "acme/gone", ref: "" })).toMatchObject({
    ok: true,
    repository: "https://github.com/acme/gone.git",
    plugins: [],
    picked: "gone",
    manual: true,
    note: "ace couldn't read that repository's marketplace.",
  });
});

test("a repository or branch that isn't one is refused before anything is fetched", async () => {
  const { ask } = await plugins();
  expect(await ask({ op: "find", repository: "not a repo", ref: "" })).toEqual({
    ok: false,
    message: "Use owner/name, a git URL, or an absolute path to a local repository.",
  });
  expect(await ask({ op: "find", repository: "acme/tools", ref: "main..dev" })).toEqual({
    ok: false,
    message: "Use a branch, tag or commit.",
  });
});

test("the chosen plugin is checked and written as the machine fetches it for review", async () => {
  const { ask } = await plugins();
  const source = { repository: "https://github.com/acme/tools.git", ref: "HEAD" };
  expect(await ask({ op: "source", ...source, name: " Sentry " })).toEqual({
    ok: true,
    prepare: { type: "plugins.prepare", ...source, name: "sentry" },
  });
  expect(await ask({ op: "source", ...source, name: "two--dashes" })).toEqual({
    ok: false,
    message: "That isn't a plugin name.",
  });
});
