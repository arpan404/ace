import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import { discoverAdapters } from "../engine/adapters.ts";
import { AdapterRegistry } from "../engine/registry.ts";

export type LazyProvider =
  | "claude"
  | "codex"
  | "opencode"
  | "cursor"
  | "cursor-sdk"
  | "acp"
  | "antigravity";

/** Real process handshakes at synthetic CLI/SDK boundaries; no provider is invoked. */
export async function discoveredProvider(provider: LazyProvider, home: string) {
  const cursor = provider === "cursor" || provider === "cursor-sdk";
  const cli = join(home, "provider");
  const fixture = new URL(
    provider === "claude" ? "./claude-controls.ts" : "./browser-mcp-cli.ts",
    import.meta.url,
  ).href;
  await writeFile(cli, `#!${process.execPath}\nimport ${JSON.stringify(fixture)};\n`, {
    mode: 0o700,
  });
  const installed: DiscoveryResult = {
    installed: true,
    path: cli,
    version: provider === "claude" ? "2.1.286" : provider === "codex" ? "0.159.1" : "2.0.22",
    auth: "unknown",
    loginHint: "synthetic",
  };
  const absent: DiscoveryResult = { installed: false, auth: "unknown", loginHint: "synthetic" };
  const env = {
    HOME: home,
    PATH: home,
    ACE_TEST_BROWSER_PROVIDER: provider,
    ACE_TEST_BROWSER_URL: `http://localhost:3000/lazy-${provider}`,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: "retained-model",
      mcp: { servers: { user: { type: "local", command: ["user-mcp"] } } },
    }),
  };
  if (provider === "acp" || provider === "antigravity") {
    const { createAcpAdapter, genericQuirks, antigravityQuirks } = await import("@ace/adapter-acp");
    const registry = new AdapterRegistry();
    registry.register(
      createAcpAdapter(provider === "acp" ? genericQuirks : antigravityQuirks, {
        command: cli,
        args: [],
        env,
      }),
      installed,
    );
    return { registry, env };
  }
  const host = join(home, "host.mjs");
  if (cursor)
    await writeFile(
      host,
      `
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
for await (const line of createInterface({input:process.stdin})) {
 const request=JSON.parse(line);
 if(request.method==='open') {
  writeFileSync(${JSON.stringify(join(home, "sdk-open.json"))},JSON.stringify({threadId:request.params.threadId,cwd:request.params.cwd}));
  console.log(JSON.stringify({id:request.id,result:{agentId:'synthetic-sdk'}}));
 }
 else if(request.method==='close') console.log(JSON.stringify({id:request.id,result:{disposed:true}}));
}
`,
    );
  const instance = { id: "lazy-sdk", homeDir: join(home, "instance") };
  const registry = await discoverAdapters(
    async () => ({
      claude: provider === "claude" ? installed : absent,
      codex: provider === "codex" ? installed : absent,
      opencode: provider === "opencode" ? installed : absent,
      cursor: absent,
    }),
    undefined,
    async () => {},
    {
      instance,
      entry: host,
      discovery: {
        resolve: (name) => join(home, name, "index.mjs"),
        read: async (path) =>
          JSON.stringify({
            name: path.includes(`sdk-${process.platform}-${process.arch}`)
              ? `@cursor/sdk-${process.platform}-${process.arch}`
              : "@cursor/sdk",
            version: "1.0.35",
          }),
        executable: async () => {},
      },
    },
    async () => ({
      installed: cursor,
      supported: cursor,
      version: "1.0.35",
    }),
  );
  return {
    registry,
    env: cursor ? { ...env, HOME: join(instance.homeDir, "user") } : env,
  };
}
