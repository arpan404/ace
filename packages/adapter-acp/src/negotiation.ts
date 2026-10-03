import { bridgeSubagents } from "./bridge-negotiation.ts";
import { z } from "zod";
import type { Capabilities, AcpSessionSupport } from "@ace/protocol";
import type { CompatibilityProfile, SelectorState } from "@ace/agent-registry";
import type { AcpQuirks } from "./quirks/types.ts";
const Initialize = z
  .object({
    protocolVersion: z.literal(1),
    agentInfo: z
      .object({ name: z.string(), version: z.string().optional() })
      .passthrough()
      .optional(),
    agentCapabilities: z
      .object({
        loadSession: z.boolean().optional(),
        sessionCapabilities: z.unknown().optional(),
        promptCapabilities: z.object({ image: z.boolean().optional() }).passthrough().optional(),
        mcpCapabilities: z
          .object({ http: z.boolean().optional(), sse: z.boolean().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .default({}),
  })
  .passthrough();
export type Negotiated = {
  capabilities: Capabilities;
  httpMcp: boolean;
  sseMcp: boolean;
  subagentSessions: boolean;
  raw: unknown;
};
export function negotiate(
  raw: unknown,
  quirks: AcpQuirks,
  version?: string,
  profile?: CompatibilityProfile,
): Negotiated {
  const response = Initialize.parse(raw);
  if (quirks.provider === "antigravity" && response.agentInfo?.name !== "antigravity-acp")
    throw new Error("Unexpected Antigravity ACP identity");
  if (
    quirks.provider === "acp" &&
    version &&
    response.agentInfo?.version &&
    response.agentInfo.version !== version
  )
    throw new Error("ACP version changed; review a new installation plan");
  const advertised = response.agentCapabilities;
  const existing = quirks.capabilities(version ?? response.agentInfo?.version);
  const generic = quirks.provider === "acp";
  const subagentSessions = bridgeSubagents(raw, profile);
  return {
    raw,
    subagentSessions,
    httpMcp: !profile?.denyHttpMcp && advertised.mcpCapabilities?.http === true,
    sseMcp: !profile?.denyHttpMcp && advertised.mcpCapabilities?.sse === true,
    capabilities: {
      ...existing,
      subagentTranscripts: generic ? subagentSessions : existing.subagentTranscripts,
      resume:
        !profile?.denyResume && advertised.loadSession === true && (generic || existing.resume),
      imageInput: advertised.promptCapabilities?.image === true && (generic || existing.imageInput),
      // Mode support is determined from the authorized session's selectors.
      planMode: false,
    },
  };
}
function boundedRaw(value: unknown): AcpSessionSupport["raw"] {
  const json = JSON.stringify(value);
  const bytes = Buffer.from(json);
  return {
    json: bytes.subarray(0, 2048).toString("utf8").replace(/�$/, ""),
    truncated: bytes.length > 2048,
  };
}
export function sessionSupport(
  negotiated: Negotiated,
  selectors: SelectorState,
  mcp: AcpSessionSupport["mcp"],
  coverage: AcpSessionSupport["coverage"],
): AcpSessionSupport {
  return {
    capabilities: {
      resume: negotiated.capabilities.resume,
      imageInput: negotiated.capabilities.imageInput,
      planMode: selectors.mode?.values.includes("plan") ?? false,
    },
    mcp,
    modelSelection: !!selectors.model,
    modeSelection: !!selectors.mode,
    subagentSessions: negotiated.subagentSessions,
    coverage,
    visibility: "limited",
    raw: boundedRaw(negotiated.raw),
  };
}
