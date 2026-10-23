import { baseCapabilities, type AcpQuirks } from "./types.ts";
export const genericQuirks: AcpQuirks = {
  provider: "acp",
  command: "",
  args: [],
  experimental: false,
  clientMeta: {},
  toolKind: () => undefined,
  classifyError: () => undefined,
  // Effort applies at session start when the agent offers a thinking-level option.
  capabilities: () => ({ ...baseCapabilities, launchOptions: ["effort"] }),
};
