// Synthetic ACP peer for opening failures. No installed provider is launched.
import { createInterface } from "node:readline";
import { z } from "zod";

const RpcError = z.object({ code: z.union([z.number(), z.string()]), message: z.string() });
const config = z
  .object({
    load: z.boolean(),
    failure: RpcError.optional(),
    initializeFailure: RpcError.optional(),
  })
  .parse(JSON.parse(process.env.ACE_ACP_RESUME_ERROR ?? "{}"));
const Request = z.object({ id: z.union([z.number(), z.string()]), method: z.string() });
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = Request.parse(JSON.parse(line));
  if (request.method === "initialize") {
    if (config.initializeFailure) write({ id: request.id, error: config.initializeFailure });
    else
      write({
        id: request.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: config.load, mcpCapabilities: { http: true } },
        },
      });
  } else if (request.method === "session/load" && config.failure)
    write({ id: request.id, error: config.failure });
  else write({ id: request.id, result: { sessionId: "native-1" } });
});
process.once("SIGTERM", () => process.stdin.destroy());
