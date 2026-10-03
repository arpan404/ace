// Synthetic local CLI boundary for daemon registration; never contacts a provider.
import { createInterface } from "node:readline";
import { z } from "zod";
if (process.argv.includes("--version")) {
  console.log("2.1.286");
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
    ? z.object({ mcpServers: object }).parse(JSON.parse(process.argv[index + 1] ?? "{}")).mcpServers
    : {};
const write = (data: unknown) => console.log(JSON.stringify(data));
for await (const line of createInterface({ input: process.stdin })) {
  const data = frame.parse(JSON.parse(line));
  if (data.type === "control_request") {
    const request = data.request ?? {};
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
                  mcpServers: Object.keys(servers).map((name) => ({
                    name,
                    status: "connected",
                    source: "dynamic",
                  })),
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
