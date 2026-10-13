// Offline model of Codex's MCP tool gate (0.162): per-server and per-tool `approval_mode`
// from the thread's config, a `mcpServer/elicitation/request` for each gated call, and a
// session grant only when the answer carries `_meta.persist: "session"`.
import { obj, str } from "../native.ts";

type Write = (data: unknown) => void;

export function aceMcpApprovals(write: Write) {
  let server: Record<string, unknown> = {};
  const remembered = new Set<string>();
  const waiting = new Map<number, (result: unknown) => void>();
  let nextRequest = 7000;
  const notify = (method: string, params: unknown) => write({ method, params });
  const gated = (tool: string) => {
    if (remembered.has(tool)) return false;
    const own = str(obj(obj(server["tools"])[tool])["approval_mode"]);
    const mode = own || str(server["default_tools_approval_mode"], "auto");
    // "auto" reads the tool's hints; ace tools that reach the world are never proven safe.
    return mode !== "approve";
  };
  const ask = (turnId: string, tool: string, args: unknown) => {
    const id = nextRequest++;
    write({
      id,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "native",
        turnId,
        serverName: "ace",
        mode: "form",
        message: `Allow the ace MCP server to run tool "${tool}"?`,
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          persist: ["session", "always"],
          tool_params: args,
        },
      },
    });
    return new Promise<unknown>((resolve) => waiting.set(id, resolve));
  };
  return {
    configure(config: unknown) {
      server = obj(obj(config)["mcp_servers.ace"]);
    },
    /** A turn text "call <tool> <n>" makes n sequential calls of that ace tool. */
    async run(turnId: string, text: string) {
      const [, tool = "", count = "1"] = text.split(" ");
      for (let call = 1; call <= Number(count); call++) {
        const id = `${tool}-${call}`;
        const args = { url: `https://example.com/${call}` };
        const item = { type: "mcpToolCall", id, server: "ace", tool, arguments: args };
        notify("item/started", {
          threadId: "native",
          turnId,
          item: { ...item, status: "inProgress" },
        });
        let allowed = true;
        if (gated(tool)) {
          const answer = obj(await ask(turnId, tool, args));
          allowed = answer["action"] === "accept";
          if (allowed && obj(answer["_meta"])["persist"] === "session") remembered.add(tool);
        }
        notify("item/completed", {
          threadId: "native",
          turnId,
          item: {
            ...item,
            status: allowed ? "completed" : "failed",
            ...(allowed
              ? { result: { content: [{ type: "text", text: "ok" }] } }
              : { error: { message: "user rejected MCP tool call" } }),
          },
        });
      }
      notify("turn/completed", { threadId: "native", turn: { id: turnId, status: "completed" } });
    },
    answer(id: unknown, result: unknown): boolean {
      if (typeof id !== "number") return false;
      const resolve = waiting.get(id);
      if (!resolve) return false;
      waiting.delete(id);
      write({ method: "serverRequest/resolved", params: { threadId: "native", requestId: id } });
      resolve(result);
      return true;
    },
  };
}
