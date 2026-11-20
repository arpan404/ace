import { bridgeSubagents } from "./bridge-negotiation.ts";
import { object } from "./data.ts";
import { z } from "zod";
import type { Capabilities, AcpSessionSupport } from "@ace/protocol";
import {
  profileFit,
  type CompatibilityProfile,
  type ProfileFit,
  type SelectorState,
} from "@ace/agent-registry";
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
        promptCapabilities: z
          .object({ image: z.boolean().optional(), embeddedContext: z.boolean().optional() })
          .passthrough()
          .optional(),
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
  /** The agent takes text appended to its system prompt (`_meta.antigravity.systemPrompt`). */
  systemPromptAppend: boolean;
  httpMcp: boolean;
  sseMcp: boolean;
  subagentSessions: boolean;
  /** How a saved session reopens: session/resume (no replay) when advertised, else session/load. */
  resumeMethod: "session/resume" | "session/load" | undefined;
  /** The profile the session runs under: none when the agent's version is outside its range. */
  profile: CompatibilityProfile | undefined;
  /**
   * How the profile covers the version the agent runs: `compatible` is in its range but not a
   * version ace verified it on.
   */
  profileFit: ProfileFit | undefined;
  /**
   * The agent reported another version than the approved one. In its profile's range it keeps
   * the profile; outside it, it runs as generic ACP.
   */
  versionChanged?: { approved: string; reported: string; runsAs: "profile" | "generic" };
  raw: unknown;
};
export function negotiate(
  raw: unknown,
  quirks: AcpQuirks,
  version?: string,
  profile?: CompatibilityProfile,
  approvedFit?: ProfileFit,
): Negotiated {
  const response = Initialize.parse(raw);
  if (quirks.provider === "antigravity" && response.agentInfo?.name !== "antigravity-acp")
    throw new Error("Unexpected Antigravity ACP identity");
  // The profile and how it fits come from ace's own record of the approved artifact (ADR 0044,
  // amendment on agents that update themselves): the version ace recorded, and the fit the
  // registry gave it. What the agent reports at `initialize` is its own claim, so it can only
  // take the profile away: outside the profile's range the session runs as generic ACP (standard
  // negotiation only); inside it, the profile stays but unverified. It never verifies a profile.
  const reported = response.agentInfo?.version;
  const changed = quirks.provider === "acp" && version && reported && reported !== version;
  const running = changed ? reported : (version ?? reported);
  let fit: ProfileFit | undefined;
  if (profile) {
    // A launch with no version at all (none approved, none reported) has nothing to check against.
    fit = approvedFit ?? (version ? profileFit(profile, version) : "verified");
    // Only a report ace has no record to compare with, or one that differs from it, is judged.
    const judged = changed ? reported : version ? undefined : reported;
    if (fit && judged) fit = profileFit(profile, judged) ? "compatible" : undefined;
  }
  if (!fit) profile = undefined;
  const versionChanged = changed
    ? { approved: version, reported, runsAs: profile ? ("profile" as const) : ("generic" as const) }
    : undefined;
  const advertised = response.agentCapabilities;
  const existing = quirks.capabilities(running);
  const generic = quirks.provider === "acp";
  const subagentSessions = bridgeSubagents(raw, profile);
  const resumeMethod =
    object(advertised.sessionCapabilities)["resume"] != null
      ? ("session/resume" as const)
      : advertised.loadSession === true
        ? ("session/load" as const)
        : undefined;
  return {
    resumeMethod,
    raw,
    profile,
    profileFit: profile ? fit : undefined,
    ...(versionChanged ? { versionChanged } : {}),
    subagentSessions,
    systemPromptAppend: advertisesSystemPromptAppend(raw),
    httpMcp: !profile?.denyHttpMcp && advertised.mcpCapabilities?.http === true,
    sseMcp: !profile?.denyHttpMcp && advertised.mcpCapabilities?.sse === true,
    capabilities: {
      ...existing,
      subagentTranscripts: generic ? subagentSessions : existing.subagentTranscripts,
      resume: !profile?.denyResume && resumeMethod !== undefined && (generic || existing.resume),
      imageInput: advertised.promptCapabilities?.image === true && (generic || existing.imageInput),
      attachmentInput: {
        format: "acp",
        documents: advertised.promptCapabilities?.embeddedContext === true ? ["*"] : [],
        embeddedContext: advertised.promptCapabilities?.embeddedContext === true,
        // `session/prompt` takes one ordered `ContentBlock[]`.
        interleaved: true,
        maxInlineBytes: 4 * 1024 * 1024,
      },
      // Mode support is determined from the authorized session's selectors.
      planMode: false,
    },
  };
}
/** Antigravity's own extension: `agentCapabilities._meta.antigravity.systemPrompt.append`. */
function advertisesSystemPromptAppend(raw: unknown): boolean {
  const meta = object(object(object(raw)["agentCapabilities"])["_meta"]);
  return object(object(meta["antigravity"])["systemPrompt"])["append"] === true;
}
function boundedRaw(value: unknown): AcpSessionSupport["raw"] {
  const json = JSON.stringify(value);
  const bytes = Buffer.from(json);
  return {
    json: bytes
      .subarray(0, 2048)
      .toString("utf8")
      .replace(/\uFFFD$/, ""),
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
