import { startMcpServer } from "@ace/mcp-server";
import { WorkspaceId, type CliOperation, type AgentControlResult } from "@ace/protocol";
import type { ServiceContext } from "../services/types.ts";
import { Enrollments } from "./enrollments.ts";
import { externalTools } from "./tools.ts";
export type ExternalMcp = Awaited<ReturnType<typeof externalMcp>>;
export async function externalMcp(context: ServiceContext) {
  const enrollments = new Enrollments(context.now, context.id);
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
          return {
            ok: true,
            data: {
              ...entry,
              url: server.url,
              claude: `claude mcp add --transport http ace ${server.url} --header 'Authorization: Bearer ${entry.bearer}'`,
              codex: `[mcp_servers.ace]\nurl = "${server.url}"\nhttp_headers = { Authorization = "Bearer ${entry.bearer}" }`,
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
