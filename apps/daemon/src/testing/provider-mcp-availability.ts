import { z } from "zod";
import { McpStatus } from "@ace/protocol";

/** Probe through the credential delivered to the fake CLI or scripted SDK boundary. */
export async function availability(url: string, authorization: string) {
  let id = 0;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...(typeof params["name"] === "string"
          ? { "Mcp-Name": params["name"] }
          : typeof params["uri"] === "string"
            ? { "Mcp-Name": params["uri"] }
            : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "fake-provider-discovery", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`MCP discovery failed: ${response.status}`);
    return z.object({ result: z.record(z.string(), z.unknown()) }).parse(await response.json())
      .result;
  };
  const instructions = z.string().parse((await request("server/discover"))["instructions"]);
  if (!instructions.includes("ace_status") || !instructions.includes("disabled"))
    throw new Error("ace discovery instructions are missing");
  const tools = z
    .array(z.object({ name: z.string(), description: z.string() }))
    .max(256)
    .parse((await request("tools/list"))["tools"]);
  if (
    !tools.some((tool) => tool.name === "ace_status" && tool.description.includes("ace://status"))
  )
    throw new Error("ace status tool is missing or undescribed");
  const resources = z
    .array(z.object({ uri: z.string() }))
    .max(256)
    .parse((await request("resources/list"))["resources"]);
  if (!resources.some((resource) => resource.uri === "ace://status"))
    throw new Error("ace status resource is missing");
  const status = McpStatus.parse(
    (await request("tools/call", { name: "ace_status", arguments: {} }))["structuredContent"],
  );
  const contents = z
    .array(z.object({ text: z.string() }))
    .parse((await request("resources/read", { uri: "ace://status" }))["contents"]);
  const resourceStatus = McpStatus.parse(JSON.parse(contents[0]?.text ?? ""));
  if (JSON.stringify(status) !== JSON.stringify(resourceStatus))
    throw new Error("Tool and resource status disagree");
  return {
    threadId: status.threadId,
    agentId: status.agentId,
    permissionMode: status.permissionMode,
    tools,
    resources,
    instructions,
  };
}
