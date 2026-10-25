import { agentOwner } from "@ace/devices/tools";
import { AgentId, type AgentControlResult, type CliOperation } from "@ace/protocol";
import type { ServiceContext } from "./types.ts";

type SimOperation = Extract<CliOperation, { op: "sim" }>;
/** The control code a device failure maps to; its own code travels in `data`. */
function controlCode(code: unknown): NonNullable<AgentControlResult["code"]> {
  switch (code) {
    case "lease_required":
    case "busy":
    case "permission_denied":
    case "screen_disabled":
      return "forbidden";
    case "not_found":
    case "stale_ref":
      return "not_found";
    case "invalid_arguments":
      return "invalid";
    case "not_supported":
      return "unsupported";
    default:
      return "unavailable";
  }
}

/**
 * `ace sim`: the thread's root agent calls a sim_* tool, as `ace task spawn` acts for the
 * parent's root agent. Same tool code, leases and refs as the MCP tools; only the rendering differs.
 */
export async function simCli(
  context: ServiceContext,
  operation: SimOperation,
  signal: AbortSignal,
): Promise<AgentControlResult> {
  const devices = context.services.devices;
  if (!devices)
    return { ok: false, code: "unsupported", hint: "This daemon does not run devices." };
  const thread = context.store.getThread(operation.threadId);
  if (!thread) return { ok: false, code: "not_found" };
  if (!thread.rootAgentId) return { ok: false, code: "not_ready" };
  const agentId = AgentId.parse(thread.rootAgentId);
  const actor = {
    kind: "agent" as const,
    owner: agentOwner(thread.id, agentId),
    threadId: thread.id,
    agentId,
  };
  // `ace sim` is someone using devices: their implementation loads here if nothing has yet.
  const { callSimTool, simFailure } = await import("@ace/devices");
  try {
    const result = await callSimTool(
      await devices.load(),
      `sim_${operation.verb}`,
      operation.args,
      actor,
      signal,
    );
    if (result.kind === "json") return { ok: true, data: result.value };
    const { image } = result;
    return {
      ok: true,
      data: {
        simId: result.simId,
        sequence: result.sequence,
        width: image.width,
        height: image.height,
        scale: image.scale,
        mimeType: "image/jpeg",
        note: result.note,
        base64: image.payload.toString("base64"),
      },
    };
  } catch (error) {
    const failure = simFailure(error);
    const hint = typeof failure["hint"] === "string" ? failure["hint"].slice(0, 512) : undefined;
    return {
      ok: false,
      code: controlCode(failure["code"]),
      ...(hint ? { hint } : {}),
      data: failure,
    };
  }
}
