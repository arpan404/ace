/** Local documented RPC peer; never imports or starts a provider CLI. */
import { createInterface } from "node:readline";
import { join } from "node:path";
import { z } from "zod";
const Request = z.looseObject({ type: z.string(), id: z.string() });
const args = process.argv.slice(2);
const extension = args[args.indexOf("-e") + 1];
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = Request.parse(JSON.parse(line));
  const data =
    request.type === "get_commands"
      ? {
          commands: [
            { name: "ace-rollback", source: "extension", sourceInfo: { path: extension } },
          ],
        }
      : request.type === "get_state"
        ? {
            sessionId: "synthetic",
            sessionFile: join(process.cwd(), "synthetic.jsonl"),
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
          }
        : {};
  process.stdout.write(
    JSON.stringify({
      type: "response",
      id: request.id,
      command: request.type,
      success: true,
      data,
    }) + "\n",
  );
}
