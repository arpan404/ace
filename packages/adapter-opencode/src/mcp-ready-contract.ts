/** OpenCode 2.0.22's public Promise plugin RPC contract. No credentials cross this RPC. */
export const mcpReadyRpc = {
  id: "ace.mcp.readiness",
  methods: {
    ready: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          tools: {
            type: "array",
            maxItems: 256,
            items: {
              type: "object",
              properties: { name: { type: "string" }, description: { type: "string" } },
              required: ["name", "description"],
              additionalProperties: false,
            },
          },
        },
        required: ["tools"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const;

/**
 * OpenCode names an MCP tool `<server>_<tool>`, so ace's always-listed `context` tool is
 * `ace_context`. Its native registration is what readiness waits for.
 */
export const aceReadinessTool = "ace_context";
