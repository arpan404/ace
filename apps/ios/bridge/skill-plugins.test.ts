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
  on: boolean;
  summary: string;
  agents: { id: string; on: boolean }[];
}
async function plugins() {
  const { daemon, client } = sheetFixture();
  daemon.seedServices({
    plugins: {
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
    )) as { ok: boolean; plugin?: PluginView; plugins?: PluginView[]; message?: string };
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
