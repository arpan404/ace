import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vitest";
import { bundleDaemon } from "@ace/release";

test("packaged OpenCode sessions wait for described native ace tools without a source checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-opencode-bundle-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const resolver = createRequire(createRequire(import.meta.url).resolve("@ace/daemon"));
  const adapter = resolver.resolve("@ace/adapter-opencode");
  const mcp = resolver.resolve("@ace/mcp-server");
  const fixture = fileURLToPath(
    new URL("../../../packages/adapter-opencode/src/testing/cli-v2.mjs", import.meta.url),
  );
  const binary = join(root, "opencode");
  await writeFile(
    binary,
    (await readFile(fixture, "utf8")).replace(/^#!.*\n/, `#!${process.execPath}\n`),
    { mode: 0o700 },
  );
  const entry = join(root, "fixture.ts");
  await writeFile(
    entry,
    `
import { createOpenCodeAdapter } from ${JSON.stringify(adapter)};
import { CredentialRegistry, ToolRegistry, nodeScheduler, startMcpServer } from ${JSON.stringify(mcp)};
const credentials = new CredentialRegistry(() => "a".repeat(64));
const server = await startMcpServer({registry:new ToolRegistry({scheduler:nodeScheduler}),credentials});
const lifetime = new AbortController();
const lease = credentials.issue({sessionId:"test",threadId:"thread",agentId:"agent",capabilities:[]},lifetime.signal);
const adapter = createOpenCodeAdapter({discovery:{overrides:{opencode:${JSON.stringify(binary)}}}});
let nativeTools;
try {
 const session = await adapter.openSession({threadId:"thread",cwd:process.cwd(),signal:lifetime.signal,aceMcp:{url:server.url,bearer:lease.bearer,end:lease.end},onExit(){},onFrame(frame){
   if(frame.channel==="http"&&frame.dir==="recv"&&frame.data.path?.includes("/rpc/ace.mcp.readiness/ready"))nativeTools=frame.data.body;
 }});
 console.log(JSON.stringify(nativeTools));
 await session.close("shutdown");
} finally {await adapter.close();lease.end();await server.close();}
`,
  );
  await bundleDaemon(resolve(import.meta.dirname, "../../.."), root, "", undefined, entry);
  await rm(entry);
  const result = await promisify(execFile)(process.execPath, [join(root, "ace.mjs")], {
    cwd: root,
    env: { HOME: root, PATH: "" },
    maxBuffer: 65536,
  });
  expect(JSON.parse(result.stdout)).toMatchObject({
    output: {
      tools: [{ name: "ace_ace_status", description: expect.stringContaining("ace://status") }],
    },
  });
});
