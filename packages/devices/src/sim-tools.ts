import { z } from "zod";
import { DeviceOperation, AppDevice, DevicePosture } from "@ace/protocol/devices";
import { ScreenUITreeResult } from "@ace/protocol";
import {
  modelImage,
  parseToolArguments,
  PublicToolError,
  PublicToolCode,
  toolFailure,
  type ModelImage,
  type ModelImageRuntime,
} from "@ace/mcp-server";
import { uiReadRequest } from "@ace/screen";
import { type DevicesService, deviceFailure } from "./service.ts";
import { DeviceError } from "./sdk.ts";
import { simSchemas, type SimToolName } from "./sim-schemas.ts";
import { simAct } from "./sim-act.ts";
import { simGuidance } from "./sim-guidance.ts";

/** The agent a sim call acts for: from its MCP credential, or the thread `ace sim` names. */
export type SimActor = { kind: "agent"; owner: string; threadId: string; agentId: string };
/** A sim tool's outcome, before an MCP or CLI surface renders it. */
export type SimResult =
  | { kind: "json"; value: unknown }
  | { kind: "image"; simId: string; sequence: number; image: ModelImage; note: string };

const Listed = z.object({ devices: z.array(z.looseObject({ id: z.string(), state: z.string() })) });
const json = (value: unknown): SimResult => ({ kind: "json", value });

/** What an agent needs after taking or releasing a simulator, not the full device state. */
function summary(raw: unknown) {
  const state = z
    .looseObject({
      device: AppDevice,
      lifecycle: z.string(),
      controller: z.string(),
      posture: DevicePosture.optional(),
    })
    .safeParse(raw);
  if (!state.success) return raw;
  const { device, lifecycle, controller, posture } = state.data;
  return {
    simId: device.id,
    name: device.name,
    state: device.state,
    lifecycle,
    controller,
    ...(posture ? { posture } : {}),
  };
}

async function run(
  service: DevicesService,
  name: SimToolName,
  args: unknown,
  actor: SimActor,
  signal: AbortSignal,
  imageRuntime: ModelImageRuntime | undefined,
): Promise<SimResult> {
  const request = (operation: unknown) => service.request(DeviceOperation.parse(operation), actor);
  switch (name) {
    case "sim_list":
      parseToolArguments(simSchemas.sim_list, args);
      return json(await request({ op: "list" }));
    case "sim_start": {
      const { simId, boot } = parseToolArguments(simSchemas.sim_start, args);
      // Taking a simulator needs no prompt; the provider's permission mode governs the call.
      await service.claimForAgent(simId, { ...actor, guard: () => signal.throwIfAborted() });
      if (boot) {
        const listed = Listed.parse(await request({ op: "list" }));
        if (listed.devices.find((device) => device.id === simId)?.state !== "booted")
          await request({ op: "boot", deviceId: simId });
      }
      const started = summary(await request({ op: "start", deviceId: simId }));
      return json(
        service.agents.firstStart(actor.owner, simId) && typeof started === "object"
          ? { ...started, guide: simGuidance(simId, actor.threadId) }
          : started,
      );
    }
    case "sim_stop": {
      const { simId } = parseToolArguments(simSchemas.sim_stop, args);
      return json(summary(await request({ op: "stop", deviceId: simId })));
    }
    case "sim_ui": {
      const { simId, ...read } = parseToolArguments(simSchemas.sim_ui, args);
      const plan = uiReadRequest(read);
      const tree = ScreenUITreeResult.parse(
        await request(
          plan.kind === "find"
            ? { op: "ui.find", deviceId: simId, ...plan.options }
            : { op: "ui.tree", deviceId: simId, ...plan.options },
        ),
      );
      const { nodes } = service.agents.refs.label(actor.owner, simId, tree.nodes);
      return json({ nodes, truncated: tree.truncated });
    }
    case "sim_act":
      return json(
        await simAct(service, service.agents, parseToolArguments(simSchemas.sim_act, args), actor),
      );
    case "sim_logs": {
      const { simId, limit } = parseToolArguments(simSchemas.sim_logs, args);
      return json(await request({ op: "logs", deviceId: simId, limit }));
    }
    case "sim_screenshot": {
      const { simId } = parseToolArguments(simSchemas.sim_screenshot, args);
      const frame = await service.screenshot(simId, actor);
      const image = await modelImage(
        { payload: frame.payload, ...frame.header },
        signal,
        imageRuntime,
      );
      signal.throwIfAborted();
      return {
        kind: "image",
        simId,
        sequence: frame.header.sequence,
        image,
        note: `${simId} frame ${frame.header.sequence}, ${image.width}x${image.height}. Divide image pixels by scale ${image.scale} for sim_act points; prefer sim_ui refs.`,
      };
    }
  }
}

/** The public failure an agent sees for an error, the same on MCP and the CLI. */
export function simPublicError(error: unknown): PublicToolError {
  if (error instanceof PublicToolError) return error;
  const failure = deviceFailure(error);
  const code = PublicToolCode.safeParse(failure.code);
  return new PublicToolError(
    code.success ? code.data : "command_failed",
    failure.permission,
    undefined,
    undefined,
    // ace wrote these messages, and they say which element or device a failure is about.
    error instanceof DeviceError ? failure.message : undefined,
  );
}
/** The failure's JSON body, exactly as the MCP tool reports it. */
export function simFailure(error: unknown): Record<string, unknown> {
  const text = toolFailure(simPublicError(error)).content[0];
  return text?.type === "text"
    ? z.record(z.string(), z.unknown()).parse(JSON.parse(text.text))
    : { code: "execution_failed" };
}

/**
 * Run one sim tool for an agent: the single implementation behind the sim_* MCP tools and the
 * `ace sim` CLI, so both reach the same device operations, leases and refs. A cancelled call
 * hands back any control the agent held, as a dropped MCP call does.
 */
export async function callSimTool(
  service: DevicesService,
  name: SimToolName,
  args: unknown,
  actor: SimActor,
  signal: AbortSignal,
  imageRuntime?: ModelImageRuntime,
): Promise<SimResult> {
  signal.throwIfAborted();
  const abort = () => service.disconnect(actor.owner);
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await run(service, name, args, actor, signal, imageRuntime);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    throw simPublicError(error);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
