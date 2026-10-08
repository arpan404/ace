// Offline CLI: native adapter frames and MCP HTTP are real edges; no inference.
import { createInterface } from "node:readline";
import { z } from "zod";
const frame = z.object({
  channel: z.string(),
  dir: z.enum(["recv", "send", "note"]).default("recv"),
  data: z.unknown(),
});
const config = z.object({
  url: z.url(),
  bearer: z.string(),
  tool: z.string(),
  args: z.unknown(),
  before: z.array(frame),
  after: z.array(frame),
  late: z.boolean().default(false),
  omit: z.boolean().default(false),
});
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const first = await lines.next();
const input = config.parse(JSON.parse(first.value ?? "null"));
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
async function emit(frames: z.infer<typeof frame>[], result?: unknown) {
  for (const native of frames) {
    const resultData = z
      .object({
        content: z.unknown().optional(),
        isError: z.boolean().optional(),
        structuredContent: z.unknown().optional(),
      })
      .safeParse(result).data;
    const encoded = JSON.stringify(native)
      .replaceAll('"$RESULT"', JSON.stringify(result ?? null))
      .replaceAll('"$CONTENT"', JSON.stringify(resultData?.content ?? []))
      .replaceAll('"$IS_ERROR"', JSON.stringify(resultData?.isError ?? false))
      .replaceAll('"$STRUCTURED"', JSON.stringify(resultData?.structuredContent ?? null));
    write({ kind: "frame", frame: JSON.parse(encoded) });
    await lines.next(); // The daemon acknowledges committed facts, never a sleep.
  }
}
if (!input.late && !input.omit) await emit(input.before);
const response = await fetch(input.url, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${input.bearer}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": "tools/call",
    "Mcp-Name": input.tool,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: input.tool,
      arguments: input.args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "offline-measurement", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  }),
});
const result = z.object({ result: z.unknown() }).parse(await response.json()).result;
write({ kind: "result", result });
await lines.next();
if (input.late && !input.omit) await emit(input.before);
if (!input.omit) await emit(input.after, result);
write({ kind: "done" });
process.exit(0);
