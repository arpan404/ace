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
