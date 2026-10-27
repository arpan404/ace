import "./test-host.ts";
import type { ClientCore } from "@ace/client";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { answerSettingsManage, SettingsManageRequest } from "./settings-manage.ts";
import { settingsFixture } from "./settings-fixture.ts";

/*
 * A provider's own MCP servers on the phone over the real SDK and an in-process fake daemon:
 * their states in words, turning one off and on, and adding URL and command servers.
 */

let client: ClientCore | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function open() {
  const fixture = await settingsFixture();
  client = fixture.owner;
  const ask = async (request: z.input<typeof SettingsManageRequest>) =>
    (await answerSettingsManage(
      fixture.owner,
      SettingsManageRequest.parse(request),
      new AbortController().signal,
    )) as Record<string, any>;
  return { ...fixture, ask };
}

test("a provider's servers read as plain words, and turning one off and on sticks", async () => {
  const { ask } = await open();
  const first = await ask({ type: "mcp.screen", provider: "codex" });
  expect(first.screen).toMatchObject({
    managed: true,
    canAdd: true,
    servers: [
      { name: "Project tools", word: "Connected", off: false },
      { name: "vercel", word: "Not signed in", off: false },
    ],
  });
  expect(
    await ask({ type: "mcp.screen.control", provider: "codex", name: "vercel", action: "disable" }),
  ).toEqual({ ok: true });
  const off = await ask({ type: "mcp.screen", provider: "codex" });
  expect(off.screen.servers[1]).toMatchObject({ word: "Off", off: true });
  await ask({ type: "mcp.screen.control", provider: "codex", name: "vercel", action: "enable" });
  expect((await ask({ type: "mcp.screen", provider: "codex" })).screen.servers[1].off).toBe(false);
});

test("command and URL servers are added and listed, a repeated name is refused", async () => {
  const { ask } = await open();
  expect(
    await ask({
      type: "mcp.screen.add",
      provider: "claude",
      name: "files",
      transport: "command",
      address: "npx -y server-files /tmp",
    }),
  ).toEqual({ ok: true, name: "files" });
  expect(
    await ask({
      type: "mcp.screen.add",
      provider: "claude",
      name: "docs",
      transport: "http",
      address: "https://example.com/mcp",
    }),
  ).toEqual({ ok: true, name: "docs" });
  const names = (await ask({ type: "mcp.screen", provider: "claude" })).screen.servers.map(
    (server: { name: string }) => server.name,
  );
  expect(names).toEqual(expect.arrayContaining(["files", "docs"]));
  const again = await ask({
    type: "mcp.screen.add",
    provider: "claude",
    name: "files",
    transport: "command",
    address: "other",
  });
  expect(again.ok).toBe(false);
});

test("a provider with no live session explains the empty list; others have no MCP page", async () => {
  const { ask, daemon } = await open();
  daemon.mcp.idle.add("opencode");
  expect((await ask({ type: "mcp.screen", provider: "opencode" })).screen).toMatchObject({
    servers: [],
    canAdd: false,
    note: "OpenCode's MCP servers show here while one of its threads is running.",
  });
  expect((await ask({ type: "mcp.screen", provider: "cursor" })).screen.managed).toBe(false);
});

test("the add form names the field to fix before anything is sent", async () => {
  const { ask } = await open();
  expect(
    await ask({ type: "mcp.screen.check", name: "my server", transport: "command", address: "x" }),
  ).toMatchObject({ field: "name" });
  expect(
    await ask({ type: "mcp.screen.check", name: "docs", transport: "http", address: "ftp://x" }),
  ).toMatchObject({ field: "address" });
  expect(
    await ask({
      type: "mcp.screen.check",
      name: "docs",
      transport: "http",
      address: "https://x.dev",
    }),
  ).toEqual({ ok: true, field: null, problem: null });
});
