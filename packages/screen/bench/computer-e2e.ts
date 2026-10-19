/*
 * Manual end-to-end run of the agent computer-use tools against the real helper and real
 * apps. Prints exactly what a model receives. Operates apps on this Mac: run only on purpose.
 *   ACE_COMPUTER_HELPER=<built helper> node packages/screen/bench/computer-e2e.ts '<json steps>'
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { ComputerClient, computerToolkit } from "../src/index.ts";

const helper = process.env["ACE_COMPUTER_HELPER"];
if (!helper) throw new Error("Set ACE_COMPUTER_HELPER");
const steps = JSON.parse(process.argv[2] ?? "[]") as [string, Record<string, unknown>][];
const client = new ComputerClient({ helper: async () => helper, nextId: randomUUID });
const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
computerToolkit(client).register(registry);
const credentials = new CredentialRegistry(() => "a".repeat(64));
const lease = credentials.issue(
  McpScope.parse({
    sessionId: "e2e",
    threadId: "thread",
    agentId: "root",
    capabilities: ["screen"],
  }),
  new AbortController().signal,
);
let shot = 0;
for (const [name, args] of steps) {
  const started = Date.now();
  const result = await registry.call(name, args, lease.principal, new AbortController().signal);
  console.log(
    `\n===== ${name} ${JSON.stringify(args)} (${Date.now() - started} ms)${result.isError ? " ERROR" : ""}`,
  );
  for (const part of result.content) {
    if (part.type === "text") console.log(part.text);
    if (part.type === "image") {
      const path = `/tmp/ace-cua-e2e/shot-${++shot}.jpg`;
      writeFileSync(path, Buffer.from(part.data, "base64"));
      console.log(`[image ${path}]`);
    }
  }
}
client.close();
credentials.close();
