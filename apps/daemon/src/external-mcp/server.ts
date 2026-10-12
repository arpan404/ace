import { startMcpServer } from "@ace/mcp-server";
import { WorkspaceId, type CliOperation, type AgentControlResult } from "@ace/protocol";
import type { ServiceContext } from "../services/types.ts";
import { Enrollments } from "./enrollments.ts";
import { externalTools } from "./tools.ts";
import { join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { z } from "zod";
import { secureDataDir } from "../local-files.ts";
import { nodeScheduler } from "@ace/mcp-server";
const enrollmentId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export type ExternalMcp = Awaited<ReturnType<typeof externalMcp>>;
export async function externalMcp(context: ServiceContext) {
  const directory = join(context.config.dataDir, "mcp-enrollments");
  secureDataDir(directory);
  const tokenPath = (id: string) => join(directory, `${enrollmentId.parse(id)}.token`);
  const enrollments = new Enrollments(context.now, context.id, nodeScheduler.after, (id) => {
    try {
      unlinkSync(tokenPath(id));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  });
  let admit: (() => boolean) | undefined;
  context.onListen.push((server) => {
    admit = () => server.maintenance.admit();
  });
  const registry = externalTools(
    context,
    enrollments,
    () => !context.signal.aborted && (admit?.() ?? false),
  );
  const server = await startMcpServer({
    registry,
    credentials: enrollments.credentials,
    status: (caller) => ({
      permissionMode: enrollments.caller(caller).scope === "read" ? "read-only" : null,
    }),
  });
  return {
    tools: [
      "ace_status",
      "ace_threads_list",
      "ace_thread_read",
      "ace_thread_status",
      "ace_thread_run",
      "ace_thread_send",
      "ace_task_control",
    ],
    async execute(
      operation: Extract<CliOperation, { op: `mcp.${string}` }>,
    ): Promise<AgentControlResult> {
      switch (operation.op) {
        case "mcp.list":
          return { ok: true, data: { enrollments: enrollments.list() } };
        case "mcp.revoke":
          return { ok: enrollments.revoke(operation.id) };
        case "mcp.enroll": {
          if (
            operation.project &&
            !context.store.getWorkspace(WorkspaceId.parse(operation.project))
          )
            return { ok: false, code: "not_found" };
          const entry = enrollments.enroll(operation.scope, operation.ttlMs, operation.project);
          const credentialFile = tokenPath(entry.id);
          try {
            writeFileSync(credentialFile, entry.bearer, { mode: 0o600, flag: "wx" });
          } catch (error) {
            enrollments.revoke(entry.id);
            throw error;
          }
          return {
            ok: true,
            data: {
              ...entry,
              url: server.url,
              credentialFile,
              setup: `export ACE_MCP_TOKEN="$(cat ${shellQuote(credentialFile)})"`,
              claude: `claude mcp add-json ace '${JSON.stringify({ type: "http", url: server.url, headers: { Authorization: "Bearer ${ACE_MCP_TOKEN}" } })}'`,
              codex: `[mcp_servers.ace]\nurl = "${server.url}"\nbearer_token_env_var = "ACE_MCP_TOKEN"`,
            },
          };
        }
      }
    },
    async close() {
      enrollments.close();
      await server.close();
    },
  };
}
