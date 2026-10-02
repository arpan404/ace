import { readFile, writeFile } from "node:fs/promises";
import { findExecutable } from "@ace/provider-kit/discovery";
import { dirname, join } from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";
import { launchPluginProcess, newPluginAcpSession, projectPlugins } from "./index.ts";
import { fixture, writeFiles, git } from "./test-support.ts";

test.each(["acp", "antigravity"] as const)(
  "%s native session/new receives portable servers alongside daemon servers",
  async (provider) => {
    const f = await fixture();
    let launched: Awaited<ReturnType<typeof launchPluginProcess>> | undefined;
    try {
      await f.manager.accept(await f.prepare());
      const root = join(f.root, "session");
      const marker = join(f.root, "session-request.json");
      const script = join(f.root, "acp.cjs");
      await writeFile(
        script,
        `require('node:readline').createInterface({ input: process.stdin }).on('line', line => { const request = JSON.parse(line); require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(request)); console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'session-1', extension: 'preserved' } })); });`,
      );
      launched = await launchPluginProcess(f.manager, provider, root, {
        command: process.execPath,
        args: [script],
        env: {},
        name: "standin-acp",
      });
      const peer = new JsonRpcPeer(launched);
      await expect(
        newPluginAcpSession(launched.sessionConfig, peer, { cwd: "relative" }),
      ).rejects.toThrow("absolute");
      const base = { name: "ace", type: "http", url: "http://127.0.0.1:1234/mcp", headers: [] };
      expect(
        await newPluginAcpSession(
          launched.sessionConfig,
          peer,
          { cwd: f.repo, mcpServers: [base] },
          (command) => findExecutable(command, { PATH: dirname(process.execPath) }),
        ),
      ).toEqual({ sessionId: "session-1", extension: "preserved" });
      const observed = z
        .object({
          method: z.string(),
          params: z.object({ cwd: z.string(), mcpServers: z.array(z.unknown()) }),
        })
        .parse(JSON.parse(await readFile(marker, "utf8")));
      expect(observed.method).toBe("session/new");
      expect(observed.params.cwd).toBe(f.repo);
      expect(observed.params.mcpServers).toContainEqual(base);
      expect(observed.params.mcpServers).toContainEqual({
        name: "ace-sample__tools",
        command: process.execPath,
        args: [join(root, "generated/plugins/sample/payload/scripts/server.js"), 'a quote: "'],
        env: [{ name: "MODE", value: "local" }],
      });
      await launched.stop({ graceMs: 0 });
      await expect(
        readFile(join(root, "generated/plugins/sample/payload/scripts/server.js")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await launched?.stop({ graceMs: 0 });
      await f.close();
    }
  },
);

test("ACP session accepts namespaces made from two maximum-length portable names", async () => {
  const plugin = "p".repeat(64);
  const name = "s".repeat(64);
  const f = await fixture({
    "ace-plugin.json": JSON.stringify({
      schemaVersion: 1,
      name: plugin,
      version: "1",
      mcpServers: { [name]: { type: "stdio", command: process.execPath } },
    }),
  });
  try {
    await writeFiles(f.repo, {
      "marketplace.json": JSON.stringify({
        name: "test",
        plugins: [{ name: plugin, source: "plugins/sample" }],
      }),
    });
    await git(f.repo, ["add", "."]);
    await git(f.repo, ["commit", "-m", "long names"]);
    await f.manager.accept(
      await f.manager.prepare({ repository: f.repo, ref: "main", name: plugin }),
    );
    const projection = projectPlugins("acp", await f.manager.installed(), {
      root: join(f.root, "session"),
    });
    let received: unknown;
    const result = await newPluginAcpSession(
      projection.sessionConfig,
      {
        async request(_method, params) {
          received = params;
          return { sessionId: "long-names" };
        },
      },
      { cwd: f.repo },
    );
    expect(result.sessionId).toBe("long-names");
    expect(received).toMatchObject({
      mcpServers: [{ name: `ace-${plugin}__${name}`, command: process.execPath }],
    });
  } finally {
    await f.close();
  }
});
