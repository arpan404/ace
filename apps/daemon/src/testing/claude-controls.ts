import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readPrivateMcpConfig } from "@ace/mcp-server";
// Synthetic local CLI boundary for daemon registration; never contacts a provider.
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { z } from "zod";
if (process.argv.includes("--version")) {
  console.log("2.1.286");
  process.exit(0);
}
if (process.argv[2] === "mcp" && process.argv[3] === "add") {
  // Provider-owned persistence double: prove the account's environment and executable are used.
  const home = z.string().parse(process.env.CLAUDE_CONFIG_DIR ?? process.env.HOME);
  await writeFile(join(home, "added-server.json"), JSON.stringify(process.argv.slice(4)));
  process.exit(0);
}
const object = z.record(z.string(), z.unknown());
const frame = z.object({
  type: z.string(),
  request_id: z.string().optional(),
  request: object.optional(),
});
const index = process.argv.indexOf("--mcp-config");
let servers =
  index >= 0
    ? z
        .object({ mcpServers: object })
        .parse(JSON.parse(readPrivateMcpConfig(z.string().parse(process.argv[index + 1]))))
        .mcpServers
    : {};
async function aceTools(config: unknown): Promise<string[]> {
  const server = z
    .object({ url: z.string(), headers: z.record(z.string(), z.string()) })
    .parse(config);
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      ...server.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "synthetic", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const reply = z
    .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })).max(1024) }) })
    .parse(await response.json());
  return reply.result.tools.map((tool) => tool.name);
}
const write = (data: unknown) => console.log(JSON.stringify(data));
for await (const line of createInterface({ input: process.stdin })) {
  const data = frame.parse(JSON.parse(line));
  if (data.type === "control_request") {
    const request = data.request ?? {};
    if (request["subtype"] === "mcp_reconnect" && request["serverName"] === "reject-lease") {
      write({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: data.request_id,
          error: `reconnect failed: ${JSON.stringify(servers["ace"])}`,
        },
      });
      continue;
    }
    if (request["subtype"] === "mcp_set_servers") servers = object.parse(request["servers"]);
    write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: data.request_id,
        response:
          request["subtype"] === "initialize"
            ? { commands: [], agents: [], models: [] }
            : request["subtype"] === "mcp_status"
              ? {
                  mcpServers: await Promise.all(
                    Object.entries(servers).map(async ([name, config]) => ({
                      aceTools: name === "ace" ? await aceTools(config) : [],
                      name,
                      config,
                      configDir: process.env.CLAUDE_CONFIG_DIR,
                      // Prove the selected CLI home without depending on private path disclosure.
                      configDirDigest: createHash("sha256")
                        .update(process.env.CLAUDE_CONFIG_DIR ?? "")
                        .digest("hex"),
                      status: "connected",
                      source: "dynamic",
                      validAceConnection:
                        name === "ace" &&
                        /^Bearer [a-f0-9]{64}$/.test(
                          String(
                            object.parse(object.parse(config)["headers"] ?? {})["Authorization"],
                          ),
                        ),
                    })),
                  ),
                }
              : request["subtype"] === "mcp_set_servers"
                ? { added: Object.keys(servers), removed: [], errors: {} }
                : {},
      },
    });
  } else if (data.type === "user") {
    write({ type: "system", subtype: "init", session_id: "synthetic", cwd: process.cwd() });
    write({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: 1900000000,
        utilization: 1.1,
        extension: "retained",
      },
    });
    write({
      type: "result",
      subtype: "success",
      is_error: false,
      terminal_reason: "completed",
      session_id: "synthetic",
    });
  }
}
