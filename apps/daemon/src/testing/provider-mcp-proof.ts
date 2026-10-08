import { availability } from "./provider-mcp-availability.ts";
import { z } from "zod";

export async function proof(
  url: string,
  authorization: string,
  features?: { url: string; deviceId: string },
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "ace_thread_info",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ace_thread_info",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "fake-provider", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`MCP authentication failed: ${response.status}`);
  const body = z
    .object({
      result: z.object({ structuredContent: z.object({ thread: z.object({ id: z.string() }) }) }),
    })
    .parse(await response.json());
  const threadId = body.result.structuredContent.thread.id;
  const featureUrl = features?.url ?? process.env["ACE_TEST_FEATURE_URL"];
  const deviceId = features?.deviceId ?? process.env["ACE_TEST_FEATURE_DEVICE"];
  if (featureUrl && deviceId) {
    const responseSchema = z.object({
      result: z.object({
        content: z.array(
          z.object({
            type: z.string(),
            text: z.string().optional(),
            mimeType: z.string().optional(),
            data: z.string().optional(),
          }),
        ),
        isError: z.boolean().optional(),
      }),
    });
    const call = async (name: string, toolArguments: unknown = {}) => {
      const featureResponse = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": name,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name,
            arguments: toolArguments,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "fake-provider", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      if (!featureResponse.ok)
        throw new Error(`Feature MCP HTTP failure: ${featureResponse.status}`);
      return responseSchema.parse(await featureResponse.json()).result;
    };
    const successful = async (name: string, toolArguments: unknown = {}) => {
      const result = await call(name, toolArguments);
      if (result.isError)
        throw new Error(`Feature tool failed: ${name}: ${JSON.stringify(result)}`);
      return result;
    };
    const text = (result: z.infer<typeof responseSchema>["result"]) => {
      const contentText = result.content[0]?.text;
      if (!contentText) throw new Error("Missing feature text response");
      return JSON.parse(contentText);
    };
    const catalogResponse = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "fake-provider", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const tools = z
      .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })).max(128) }) })
      .parse(await catalogResponse.json()).result.tools;
    const advertised = new Set(tools.map((tool) => tool.name));
    for (const name of [
      ...[
        "navigate",
        "click",
        "type",
        "press",
        "scroll",
        "snapshot",
        "screenshot",
        "evaluate",
        "wait_for",
        "logs",
        "resize",
        "emulate",
      ].map((action) => `ace_browser_${action}`),
      ...["ui_tree", "ui_find", "ui_act", "screenshot", "click", "type", "key", "scroll"].map(
        (action) => `screen_${action}`,
      ),
      ...[
        "list",
        "boot",
        "open_app",
        "open_url",
        "screenshot",
        "ui_tree",
        "find",
        "act",
        "tap",
        "swipe",
        "type",
        "key",
        "logs",
        "record_start",
        "record_stop",
        "install",
      ].map((action) => `device_${action}`),
    ])
      if (!advertised.has(name)) throw new Error(`Missing scoped feature catalog tool: ${name}`);
    await successful("ace_browser_navigate", { url: featureUrl });
    const snapshot = z
      .object({ nodes: z.array(z.object({ name: z.string(), ref: z.string().optional() })) })
      .parse(text(await successful("ace_browser_snapshot")));
    const input = snapshot.nodes.find((node) => node.name === "Name")?.ref;
    const save = snapshot.nodes.find((node) => node.name === "Save")?.ref;
    if (!input || !save) throw new Error("Real browser snapshot lost semantic controls");
    await successful("ace_browser_type", { ref: input, text: "provider-input" });
    await successful("ace_browser_click", { ref: save });
    const screenshot = (await successful("ace_browser_screenshot")).content[0];
    if (
      screenshot?.type !== "image" ||
      screenshot.mimeType !== "image/jpeg" ||
      !screenshot.data ||
      Buffer.from(screenshot.data, "base64").readUInt16BE(0) !== 0xffd8
    )
      throw new Error("Real browser screenshot was not an inline JPEG");
    const screen = z
      .object({ nodes: z.array(z.object({ name: z.string(), ref: z.string() })) })
      .parse(text(await successful("screen_ui_tree")));
    const screenSave = screen.nodes.find((node) => node.name === "Save")?.ref;
    if (!screenSave) throw new Error("Screen tree lost approved target");
    await successful("screen_ui_act", { ref: screenSave, action: "press" });
    const inventory = z
      .object({ devices: z.array(z.object({ id: z.string() })) })
      .parse(text(await successful("device_list")));
    if (!inventory.devices.some((device) => device.id === deviceId))
      throw new Error("Approved device unavailable");
    await successful("device_tap", { deviceId, x: 3, y: 4 });
    if (!(await call("device_tap", { deviceId, x: 9, y: 9, threadId: "another-thread" })).isError)
      throw new Error("Device MCP accepted forged caller identity");
    if (
      !(await call("ace_browser_type", { ref: input, text: "forged", threadId: "another-thread" }))
        .isError
    )
      throw new Error("Browser MCP accepted forged caller identity");
  }
  const status = await availability(url, authorization);
  if (status.threadId !== threadId) throw new Error("MCP discovery lost caller scope");
  return threadId;
}
