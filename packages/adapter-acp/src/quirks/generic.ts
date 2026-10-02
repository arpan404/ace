import { baseCapabilities, type AcpQuirks } from "./types.ts";
export const genericQuirks: AcpQuirks = {
  provider: "acp",
  command: "",
  args: [],
  experimental: false,
  clientMeta: {},
  toolKind: () => undefined,
  classifyError: () => undefined,
  capabilities: () => ({ ...baseCapabilities }),
};
